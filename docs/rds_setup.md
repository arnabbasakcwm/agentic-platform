# Aurora / RDS setup (AWS side)

What to set up in AWS before connecting an Aurora or RDS database (PostgreSQL or MySQL) as a data source. The platform-side plan is in `docs/rds_plan.md`.

Region in the examples: `ap-south-1`. Run the CLI as an admin, not as the platform's IAM user.

## 1. Turn on IAM database authentication
```bash
# Aurora
aws rds modify-db-cluster --db-cluster-identifier <CLUSTER_ID> \
  --enable-iam-database-authentication --apply-immediately --region ap-south-1
# RDS instance
aws rds modify-db-instance --db-instance-identifier <INSTANCE_ID> \
  --enable-iam-database-authentication --apply-immediately --region ap-south-1
# Check, and note endpoint, port, resource id (cluster-XXXX / db-XXXX)
aws rds describe-db-clusters --db-cluster-identifier <CLUSTER_ID> \
  --query "DBClusters[0].[IAMDatabaseAuthenticationEnabled,Endpoint,Port,DbClusterResourceId]"
```
For Aurora, use the reader endpoint, so queries go to replicas.

## 2. Require TLS
- PostgreSQL: `rds.force_ssl = 1`. This is the default on PostgreSQL 15 and later.
- MySQL: `require_secure_transport = ON`.
- Both settings go in a custom (cluster) parameter group. Reboot if the parameter is static.
- Download the CA bundle:
  `curl -o global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`

## 3. Read-only database user (name starts with `agentic_`)
PostgreSQL:
```sql
CREATE USER agentic_reader;
GRANT rds_iam TO agentic_reader;
GRANT CONNECT ON DATABASE <DB_NAME> TO agentic_reader;
GRANT USAGE ON SCHEMA public TO agentic_reader;
GRANT SELECT ON public.orders, public.customers TO agentic_reader;
ALTER ROLE agentic_reader SET default_transaction_read_only = on;
ALTER ROLE agentic_reader SET statement_timeout = '30s';
ALTER ROLE agentic_reader CONNECTION LIMIT 10;
```
MySQL / MariaDB:
```sql
CREATE USER 'agentic_reader'@'%' IDENTIFIED WITH AWSAuthenticationPlugin AS 'RDS' REQUIRE SSL;
GRANT SELECT ON <DB_NAME>.orders TO 'agentic_reader'@'%';
ALTER USER 'agentic_reader'@'%' WITH MAX_USER_CONNECTIONS 10;
```

## 4. IAM
Platform IAM user, as an inline policy:
```json
{"Version": "2012-10-17", "Statement": [
  {"Effect": "Allow", "Action": ["rds:DescribeDBClusters", "rds:DescribeDBInstances"], "Resource": "*"},
  {"Effect": "Allow", "Action": "rds-db:connect",
   "Resource": "arn:aws:rds-db:ap-south-1:<ACCOUNT_ID>:dbuser:<RESOURCE_ID>/agentic_*"}
]}
```
The AgentCore execution role needs the same `rds-db:connect` statement. Platform-created roles
will get it automatically after Part B.

## 5. Network for deployments (AgentCore VPC mode)
1. Choose private subnets in the database's VPC, two AZs if possible. Check that VPC mode supports
   those AZs.
2. Give the subnets egress: a NAT gateway on `0.0.0.0/0`. The alternative, with Bedrock-only
   models, is VPC endpoints for bedrock-runtime, logs, s3, sts and ecr.
3. Create a runtime security group (`agentic-runtime-sg`): no inbound rules, all egress.
4. On the database's SG, allow inbound 5432/3306 **from `agentic-runtime-sg`**.
5. Note the subnet ids and the runtime SG id.
6. The deploying identity needs `iam:CreateServiceLinkedRole` (AgentCore's networking
   service-linked role, created once) and `ec2:Describe*`.

## 6. Local tunnel (SSM, no SSH port)
- Bastion: a `t4g.nano` in a private subnet with `AmazonSSMManagedInstanceCore`, and its SG
  allowed on the database's SG.
- Install the Session Manager plugin, then run:
```bash
aws ssm start-session --region ap-south-1 --target <BASTION_INSTANCE_ID> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters host=<DB_ENDPOINT>,portNumber=5432,localPortNumber=15432
```
- In `backend/.env`: `RDS_LOCAL_TUNNELS=<DB_ENDPOINT>=127.0.0.1:15432`

## 7. Check before Part B (as the platform's IAM user)
```bash
TOKEN=$(aws rds generate-db-auth-token --region ap-south-1 \
  --hostname <DB_ENDPOINT> --port 5432 --username agentic_reader)
PGPASSWORD="$TOKEN" psql "host=<DB_ENDPOINT> hostaddr=127.0.0.1 port=15432 \
  dbname=<DB_NAME> user=agentic_reader sslmode=verify-full sslrootcert=global-bundle.pem" \
  -c "SHOW transaction_read_only;" -c "SELECT count(*) FROM public.orders;"
mysql -h 127.0.0.1 -P 15432 -u agentic_reader --password="$TOKEN" \
  --ssl-ca=global-bundle.pem --enable-cleartext-plugin -e "SELECT COUNT(*) FROM <DB_NAME>.orders;"
```
Expected results:
- `transaction_read_only = on`.
- The count works.
- An `INSERT` fails.

## Values for the connect form
Engine, region, cluster/instance id, database, database user, subnets, runtime SG.
