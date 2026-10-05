"""Thin wrapper over the AWS APIs a deployment needs: S3 for the code package, IAM for the
runtime's execution role, and Amazon Bedrock AgentCore for the runtime itself.

Everything AWS-specific lives here so deploy.py can be tested against a fake, and so the
exact request shapes are tested once against botocore's stubber. Credentials come from
the standard boto3 chain (`aws configure`, SSO, environment variables, an instance role).
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, ReadTimeoutError

from .errors import DeployedRunError, DeployError

AGENTCORE_PYTHON = "PYTHON_3_11"
# Runtime names the platform creates: "agentic_<project id>"; used to scope IAM policy.
RUNTIME_NAME_PREFIX = "agentic_"
# Matches the "AmazonBedrockAgentCore*" PassRole pattern in AWS's suggested IAM policy.
ROLE_NAME_TEMPLATE = "AmazonBedrockAgentCoreAgenticPlatform-{region}"
# Matches the "bedrock-agentcore-*" bucket pattern in AWS's suggested IAM policy.
BUCKET_TEMPLATE = "bedrock-agentcore-agentic-platform-{account}-{region}"

READY = "READY"
FAILED_STATES = {"CREATE_FAILED", "UPDATE_FAILED", "DELETE_FAILED"}


def _code(error: ClientError) -> str:
    return error.response.get("Error", {}).get("Code", "")


class AgentCoreCloud:
    def __init__(
        self,
        region: str,
        session: Any | None = None,
        role_arn: str | None = None,
        bucket: str | None = None,
    ):
        session = session or boto3.Session(region_name=region)
        self.region = region
        self._session = session
        self._role_arn = role_arn
        self._bucket = bucket
        self._account: str | None = None
        self.s3 = session.client("s3", region_name=region)
        self.iam = session.client("iam", region_name=region)
        self.sts = session.client("sts", region_name=region)
        self.control = session.client("bedrock-agentcore-control", region_name=region)
        self.data = session.client("bedrock-agentcore", region_name=region)
        self._invoke_clients: dict[int, Any] = {}

    # ------------------------------------------------------------------ identity
    def account_id(self) -> str:
        if self._account is None:
            self._account = self.sts.get_caller_identity()["Account"]
        return self._account

    @property
    def bucket(self) -> str:
        return self._bucket or BUCKET_TEMPLATE.format(account=self.account_id(), region=self.region)

    # ------------------------------------------------------------------ code package
    def ensure_bucket(self) -> None:
        try:
            self.s3.head_bucket(Bucket=self.bucket, ExpectedBucketOwner=self.account_id())
            return
        except ClientError as e:
            if _code(e) not in ("404", "NoSuchBucket", "NotFound"):
                raise
        create: dict[str, Any] = {"Bucket": self.bucket}
        if self.region != "us-east-1":
            create["CreateBucketConfiguration"] = {"LocationConstraint": self.region}
        self.s3.create_bucket(**create)
        # Code packages are private; nothing in this bucket is ever served publicly.
        self.s3.put_public_access_block(
            Bucket=self.bucket,
            PublicAccessBlockConfiguration={
                "BlockPublicAcls": True,
                "IgnorePublicAcls": True,
                "BlockPublicPolicy": True,
                "RestrictPublicBuckets": True,
            },
        )

    def upload(self, path: str, key: str) -> None:
        self.s3.upload_file(path, self.bucket, key, ExtraArgs={"ExpectedBucketOwner": self.account_id()})

    def delete_code(self, prefix: str) -> None:
        paginator = self.s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            keys = [{"Key": obj["Key"]} for obj in page.get("Contents", [])]
            if keys:
                self.s3.delete_objects(Bucket=self.bucket, Delete={"Objects": keys})

    # ------------------------------------------------------------------ execution role
    def _trust_policy(self) -> dict[str, Any]:
        account = self.account_id()
        return {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Principal": {"Service": "bedrock-agentcore.amazonaws.com"},
                    "Action": "sts:AssumeRole",
                    "Condition": {
                        "StringEquals": {"aws:SourceAccount": account},
                        "ArnLike": {"aws:SourceArn": f"arn:aws:bedrock-agentcore:{self.region}:{account}:*"},
                    },
                }
            ],
        }

    def _role_policy(self) -> dict[str, Any]:
        account, region = self.account_id(), self.region
        log_groups = f"arn:aws:logs:{region}:{account}:log-group:/aws/bedrock-agentcore/runtimes"
        return {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Sid": "ReadCodePackages",
                    "Effect": "Allow",
                    "Action": ["s3:GetObject"],
                    "Resource": [f"arn:aws:s3:::{self.bucket}/*"],
                },
                {
                    "Effect": "Allow",
                    "Action": ["logs:DescribeLogStreams", "logs:CreateLogGroup"],
                    "Resource": [f"{log_groups}/*"],
                },
                {
                    "Effect": "Allow",
                    "Action": ["logs:DescribeLogGroups"],
                    "Resource": [f"arn:aws:logs:{region}:{account}:log-group:*"],
                },
                {
                    "Effect": "Allow",
                    "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
                    "Resource": [f"{log_groups}/*:log-stream:*"],
                },
                {
                    "Effect": "Allow",
                    "Action": [
                        "xray:PutTraceSegments",
                        "xray:PutTelemetryRecords",
                        "xray:GetSamplingRules",
                        "xray:GetSamplingTargets",
                    ],
                    "Resource": ["*"],
                },
                {
                    "Effect": "Allow",
                    "Action": "cloudwatch:PutMetricData",
                    "Resource": "*",
                    "Condition": {"StringEquals": {"cloudwatch:namespace": "bedrock-agentcore"}},
                },
                {
                    "Sid": "GetAgentAccessToken",
                    "Effect": "Allow",
                    "Action": [
                        "bedrock-agentcore:GetWorkloadAccessToken",
                        "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
                    ],
                    "Resource": [
                        f"arn:aws:bedrock-agentcore:{region}:{account}:workload-identity-directory/default",
                        f"arn:aws:bedrock-agentcore:{region}:{account}:workload-identity-directory/default/workload-identity/{RUNTIME_NAME_PREFIX}*",
                    ],
                },
            ],
        }

    def ensure_role(self) -> str:
        """The configured execution role, or the platform's own one (created if missing)."""
        if self._role_arn:
            return self._role_arn
        name = ROLE_NAME_TEMPLATE.format(region=self.region)
        try:
            return self.iam.get_role(RoleName=name)["Role"]["Arn"]
        except ClientError as e:
            if _code(e) != "NoSuchEntity":
                raise
        arn = self.iam.create_role(
            RoleName=name,
            AssumeRolePolicyDocument=json.dumps(self._trust_policy()),
            Description="Execution role for runtimes deployed by the Agentic Platform",
        )["Role"]["Arn"]
        self.iam.put_role_policy(
            RoleName=name,
            PolicyName="AgenticPlatformRuntime",
            PolicyDocument=json.dumps(self._role_policy()),
        )
        return arn

    # ------------------------------------------------------------------ runtime
    def deploy_runtime(
        self,
        name: str,
        code_key: str,
        environment: dict[str, str],
        role_arn: str,
        existing_runtime_id: str | None = None,
        description: str = "",
        role_retry_s: float = 5.0,
        role_retry_attempts: int = 12,
    ) -> tuple[str, str]:
        """Create the runtime, or point an existing one at a new code package.
        Returns (runtime id, runtime ARN)."""
        params: dict[str, Any] = {
            "agentRuntimeArtifact": {
                "codeConfiguration": {
                    "code": {"s3": {"bucket": self.bucket, "prefix": code_key}},
                    "runtime": AGENTCORE_PYTHON,
                    "entryPoint": ["main.py"],
                }
            },
            "roleArn": role_arn,
            # Agents call LLM providers on the public internet.
            "networkConfiguration": {"networkMode": "PUBLIC"},
            "environmentVariables": environment,
        }
        if description:
            params["description"] = description[:4096]

        # A role created moments ago can take a few seconds to become assumable.
        for attempt in range(1, role_retry_attempts + 1):
            try:
                if existing_runtime_id:
                    response = self.control.update_agent_runtime(
                        agentRuntimeId=existing_runtime_id, **params
                    )
                else:
                    response = self.control.create_agent_runtime(agentRuntimeName=name, **params)
                return response["agentRuntimeId"], response["agentRuntimeArn"]
            except ClientError as e:
                message = e.response.get("Error", {}).get("Message", "")
                retryable = _code(e) == "ValidationException" and "role" in message.lower()
                if not retryable or attempt == role_retry_attempts:
                    raise
                time.sleep(role_retry_s)
        raise AssertionError("unreachable")

    def wait_until_ready(self, runtime_id: str, timeout_s: float = 900, poll_s: float = 10) -> None:
        deadline = time.monotonic() + timeout_s
        while True:
            runtime = self.control.get_agent_runtime(agentRuntimeId=runtime_id)
            status = runtime.get("status")
            if status == READY:
                return
            if status in FAILED_STATES:
                reason = runtime.get("failureReason") or "no reason given"
                raise DeployError(f"AgentCore reported {status}: {reason}")
            if time.monotonic() > deadline:
                raise DeployError(f"runtime still {status} after {int(timeout_s)}s")
            time.sleep(poll_s)

    def delete_runtime(self, runtime_id: str) -> None:
        try:
            self.control.delete_agent_runtime(agentRuntimeId=runtime_id)
        except ClientError as e:
            if _code(e) != "ResourceNotFoundException":
                raise

    def _invoke_client(self, read_timeout_s: int) -> Any:
        """A data-plane client that waits `read_timeout_s` for a run to answer and never
        retries: botocore's default (60 s, then retry) would give up on a slow but healthy
        run and start the same run again — each retry a full, billed multi-agent run."""
        client = self._invoke_clients.get(read_timeout_s)
        if client is None:
            client = self._session.client(
                "bedrock-agentcore",
                region_name=self.region,
                config=Config(
                    connect_timeout=10,
                    read_timeout=read_timeout_s,
                    retries={"total_max_attempts": 1},
                ),
            )
            self._invoke_clients[read_timeout_s] = client
        return client

    def invoke(
        self, runtime_arn: str, payload: dict[str, Any], timeout_s: float | None = None
    ) -> dict[str, Any]:
        """Call a deployed runtime's /invocations and return its JSON body.

        `timeout_s` is the run's own time limit: the runtime enforces it and answers with a
        RunTimeout error, so the platform waits a little longer than that for the answer."""
        read_timeout = invoke_read_timeout(timeout_s)
        try:
            response = self._invoke_client(read_timeout).invoke_agent_runtime(
            agentRuntimeArn=runtime_arn,
            # Each call is independent; AgentCore requires a 33+ character session id.
                runtimeSessionId=uuid.uuid4().hex + uuid.uuid4().hex,
                payload=json.dumps(payload).encode("utf-8"),
                contentType="application/json",
                accept="application/json",
                qualifier="DEFAULT",
            )
            raw = response["response"].read()
        except ReadTimeoutError:
            raise DeployedRunError(
                504,
                "RunTimeout",
                f"the deployed flow didn't answer within {read_timeout} seconds; raise the "
                "plan's time limit (bounds.timeout_s) and redeploy if runs need longer",
            ) from None
        try:
            body = json.loads(raw)
        except ValueError as e:
            raise DeployedRunError(502, "BadRuntimeResponse", "the runtime returned non-JSON output") from e
        status = int(response.get("statusCode", 200))
        if status >= 400 or "error_type" in body:
            raise DeployedRunError(
                status if status >= 400 else 502,
                body.get("error_type", "RuntimeError"),
                body.get("message", "the deployed runtime reported an error"),
            )
        return body


# A synchronous AgentCore invocation can't wait longer than 15 minutes.
MAX_INVOKE_WAIT_S = 900
# Time on top of the run's own limit: the runtime's reply, start-up of a cold runtime.
INVOKE_GRACE_S = 60


def invoke_read_timeout(run_timeout_s: float | None) -> int:
    """How long to wait for a deployed run: its own limit plus a grace period, capped at
    AgentCore's maximum. Without a limit, the platform's default run limit."""
    from .agent_schema import RunBounds

    limit = run_timeout_s if run_timeout_s and run_timeout_s > 0 else RunBounds().timeout_s
    return int(min(limit + INVOKE_GRACE_S, MAX_INVOKE_WAIT_S))


def make_cloud(region: str, role_arn: str | None, bucket: str | None) -> AgentCoreCloud | None:
    """An AgentCoreCloud if AWS credentials are available, else None (deploy disabled).
    Only looks for credentials locally; makes no network call."""
    session = boto3.Session(region_name=region)
    if session.get_credentials() is None:
        return None
    return AgentCoreCloud(region, session=session, role_arn=role_arn, bucket=bucket)
