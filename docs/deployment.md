# Deploying the platform to a Linux server

The platform (API, console and MongoDB) runs as three containers on one server with
Docker Compose. Caddy serves the console, proxies `/api` to the API and gets an HTTPS
certificate automatically. This is the platform itself; the agent teams it builds still
deploy to Bedrock AgentCore from the console.

| Container | What it is | Reachable from |
|---|---|---|
| `web` | Caddy + the built console | ports 80 / 443 |
| `api` | FastAPI (`uvicorn`, one worker) | `web` only, as `/api` |
| `mongo` | MongoDB 8 with auth, data in the `mongo-data` volume | `api` only |

## 1. Prepare the server

- **Server:** a Linux server with 2 vCPU and 4 GB RAM or more (Ubuntu 24.04, Amazon Linux
  2023 or similar), x86_64 or arm64.
- **Docker:** install Docker Engine and the Compose plugin (`docker compose version`
  should work), plus `git` and `curl`.
- **Firewall:** open ports 80 and 443 (and 22 for SSH) and nothing else. MongoDB is not
  published.
- **DNS:** point your domain's A/AAAA record at the server *before* the first deploy,
  so Caddy can get the certificate.
- **AWS access:** for Bedrock models and AgentCore deploys, attach an IAM instance role
  on EC2. Set the instance metadata hop limit to 2 so containers can reach it:
  `aws ec2 modify-instance-metadata-options --instance-id <id> --http-put-response-hop-limit 2`.
  Elsewhere, put an IAM user's keys in `.env.production`.

## 2. Configure

```bash
git clone <repo-url> agentic-platform && cd agentic-platform
cp .env.production.example .env.production
chmod 600 .env.production
```

Fill in at least these values in `.env.production`:

- `DOMAIN`
- `MONGO_ROOT_PASSWORD` (`openssl rand -hex 24`)
- `JWT_SECRET` (`openssl rand -base64 48`)
- `PLATFORM_SECRET_KEY`
- the provider keys your projects use

`deploy.sh` refuses to start if a required value is missing or is still the example value.

## 3. Deploy

```bash
./deploy.sh
```

This builds both images (tagged with the git commit), starts the stack, waits for
MongoDB and the API to report healthy, and checks `https://<DOMAIN>/api/health`.

To update the server later, pull the new code and run the script again:

```bash
git pull && ./deploy.sh
```

Other commands: `./deploy.sh status | logs [api|web|mongo] | backup | restore <file> | down`.

API docs are served at `https://<DOMAIN>/api/docs`.

## 4. Move existing data (optional)

To bring your local data over, dump it from the local container. Run this on your own
machine, with the local container `agentic-mongo`:

```bash
docker exec agentic-mongo mongodump --db agentic_platform --archive --gzip > local.archive.gz
```

Then copy the file to the server and restore it:

```bash
./deploy.sh restore local.archive.gz
```

`.env.production` must have `MONGODB_DB=agentic_platform`, the name the dump was taken
from, and the **same `PLATFORM_SECRET_KEY`** as your local `backend/.env`. Otherwise
stored MCP server credentials can't be decrypted and must be reconnected. Users sign in
with their existing passwords; `JWT_SECRET` only affects tokens, so everyone simply signs
in again.

## 5. Operate

- **Backups:** `./deploy.sh backup` writes `backups/mongo-<time>.archive.gz`. Schedule
  it from cron and copy the files off the server (S3, for example):
  `0 3 * * * cd /path/to/agentic-platform && ./deploy.sh backup`
- **Logs:** run `./deploy.sh logs api`. Containers log to Docker's json-file driver;
  configure log rotation in `/etc/docker/daemon.json` (`"log-opts": {"max-size": "20m",
  "max-file": "5"}`).
- **One API worker, on purpose:** runs, deploys, knowledge indexing and usage sync are
  in-process background jobs until the job queue exists. A restart (each deploy
  included) cuts off runs and deploys in flight. Deploy when nothing is running.
- **Behind a load balancer:** to use an ALB that terminates TLS, set `DOMAIN=:80` and
  point the load balancer at port 80.
- **Admins:** make the master admin on the server once their account is registered:
  `docker compose -f docker-compose.prod.yml exec api uv run python scripts/set_role.py you@example.com master`.
  After that, the master adds and removes admins from the console's Admin page; other
  admins only see usage. Running the same command with another email moves the master
  role (the previous master becomes an admin).

## Known gaps before multi-tenant production

These come from the decision log in `CLAUDE.md` and are not solved by this setup:

- no rate limiting or login throttling
- provider keys reach AgentCore runtimes as environment variables
- no job queue
- BigQuery federation trusts the platform's identity, not the tenant's
