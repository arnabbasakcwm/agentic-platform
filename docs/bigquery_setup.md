# BigQuery access setup (Workload Identity Federation from AWS)

How Google Cloud project `agenticdb-510807` was set up on 2026-10-06 so the platform's
agents can read BigQuery **without any Google key file**:

- **Locally:** the platform signs in to Google with its AWS identity, the IAM user
  `arnab-test`.
- **When deployed:** a flow on AgentCore uses its execution role,
  `AmazonBedrockAgentCoreAgenticPlatform-ap-south-1`.
- **What it may do:** Google exchanges that identity for a short-lived token of a
  read-only service account.

The design and the build plan are in [bigquery_live_queries.md](bigquery_live_queries.md).

| | Value |
|---|---|
| GCP project | `agenticdb-510807` (number `119502061048`) |
| AWS account | `451058046921` |
| Workload identity pool / provider | `agentic-platform` / `aws-provider` |
| Service account | `agentic-bq-reader@agenticdb-510807.iam.gserviceaccount.com` |
| Dataset | `mydata` (location `US`): `trips`, `stations` |

All commands run in **Cloud Shell** with the project selected, as an Owner of the project.
Nothing is configured on the AWS side: federation only signs an `sts:GetCallerIdentity`
request, which every AWS identity may make.

---

## 1. Variables and APIs

```bash
PROJECT_ID=$(gcloud config get-value project)
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
AWS_ACCOUNT=451058046921
SA=agentic-bq-reader@$PROJECT_ID.iam.gserviceaccount.com
POOL=projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/agentic-platform
echo "Using $PROJECT_ID ($PROJECT_NUMBER)"

gcloud services enable bigquery.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com
```

> Cloud Shell forgets these variables when it reconnects. Run this block again before
> continuing, or later commands fail. An empty `$SA` gives
> `argument SERVICE_ACCOUNT: Must be specified`.

## 2. Trust the AWS account (pool + provider)

```bash
gcloud iam workload-identity-pools create agentic-platform \
  --location=global --display-name="Agentic Platform"

gcloud iam workload-identity-pools providers create-aws aws-provider \
  --location=global --workload-identity-pool=agentic-platform --account-id=$AWS_ACCOUNT
```

> A provider ID must be 4–32 characters. `aws` was refused with
> `INVALID_ARGUMENT: Invalid WorkloadIdentityPoolProvider ID`.

## 3. Read-only service account

```bash
gcloud iam service-accounts create agentic-bq-reader \
  --display-name="Agentic Platform BigQuery reader"

# May run query jobs, billed to this project; reads only the datasets shared in step 6.
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member=serviceAccount:$SA --role=roles/bigquery.jobUser --condition=None
```

## 4. Let only the two AWS identities act as the service account

```bash
# The IAM user (the platform running locally)
gcloud iam service-accounts add-iam-policy-binding $SA --role=roles/iam.workloadIdentityUser \
  --member="principal://iam.googleapis.com/$POOL/subject/arn:aws:iam::$AWS_ACCOUNT:user/arnab-test"

# The AgentCore execution role (deployed flows)
gcloud iam service-accounts add-iam-policy-binding $SA --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/$POOL/attribute.aws_role/arn:aws:sts::$AWS_ACCOUNT:assumed-role/AmazonBedrockAgentCoreAgenticPlatform-ap-south-1"
```

> The service account must exist first (step 3). Otherwise these fail with
> `NOT_FOUND: Unknown service account`. A just-created account can take up to a minute
> to be found.

## 5. Sample data: dataset `mydata`

The project had no data, so a dataset was filled from Google's public Austin bikeshare
data. It has to be created in `US`, because the public data is there and BigQuery
doesn't copy between locations.

```bash
bq --location=US mk --dataset $PROJECT_ID:mydata

# Trips since 2023 (1,070,615 rows, 2023-01-01 to 2026-08-31)
bq query --use_legacy_sql=false --location=US \
  "CREATE TABLE \`$PROJECT_ID.mydata.trips\` AS
   SELECT * FROM \`bigquery-public-data.austin_bikeshare.bikeshare_trips\`
   WHERE start_time >= '2023-01-01'"

# Stations, so trips can be joined to station details
bq query --use_legacy_sql=false --location=US \
  "CREATE TABLE \`$PROJECT_ID.mydata.stations\` AS
   SELECT * FROM \`bigquery-public-data.austin_bikeshare.bikeshare_stations\`"

# Check
bq query --use_legacy_sql=false --location=US \
  "SELECT COUNT(*) AS trips, MIN(start_time) AS first, MAX(start_time) AS last FROM \`$PROJECT_ID.mydata.trips\`"
```

> **Sandbox:** the project has no billing account, so BigQuery runs in sandbox mode:
> - queries are free within the sandbox limits;
> - tables are deleted automatically after **60 days**;
> - DML (`INSERT`/`UPDATE`/`DELETE`) is refused.
>
> To keep the data, enable billing and remove the table expiration.

## 6. Share the dataset with the service account (read-only)

```bash
bq query --use_legacy_sql=false --location=US \
  "GRANT \`roles/bigquery.dataViewer\` ON SCHEMA \`$PROJECT_ID.mydata\` TO \"serviceAccount:$SA\""
```

Repeat for any other dataset agents may read. Public datasets
(`bigquery-public-data.*`) need no grant: every account can read them.

## 7. Verify

```bash
# Who may act as the service account: the IAM user and the execution role
gcloud iam service-accounts get-iam-policy $SA --format='value(bindings.members)'

# The provider exists
gcloud iam workload-identity-pools providers list \
  --workload-identity-pool=agentic-platform --location=global --format='value(name)'

# The service account can read mydata
bq show --format=prettyjson $PROJECT_ID:mydata | grep -A2 agentic-bq-reader
```

**Checked from the platform's machine** (read-only, free) with the AWS keys in
`backend/.env`:
- signing in as `arn:aws:iam::451058046921:user/arnab-test` worked;
- listing returned dataset `mydata` with tables `stations` and `trips`;
- a dry run of a "top start stations" query estimated 23 MB scanned.

## 8. Platform settings

Print the values:

```bash
echo "GCP_WIF_AUDIENCE=//iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/agentic-platform/providers/aws-provider"
echo "GCP_SERVICE_ACCOUNT=$SA"
echo "BIGQUERY_PROJECT=$PROJECT_ID"
```

The resulting lines for `backend/.env` are identifiers, not secrets:

```
GCP_WIF_AUDIENCE=//iam.googleapis.com/projects/119502061048/locations/global/workloadIdentityPools/agentic-platform/providers/aws-provider
GCP_SERVICE_ACCOUNT=agentic-bq-reader@agenticdb-510807.iam.gserviceaccount.com
BIGQUERY_PROJECT=agenticdb-510807
```

## Undo (if ever needed)

```bash
bq rm -r -f $PROJECT_ID:mydata
gcloud iam service-accounts delete $SA
gcloud iam workload-identity-pools delete agentic-platform --location=global
```
