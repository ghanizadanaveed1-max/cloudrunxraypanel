#!/usr/bin/env bash
# One-command deploy from Google Cloud Shell:  bash deploy.sh
set -euo pipefail

SERVICE="${SERVICE:-ghanizada-panel}"
REGION="${REGION:-us-central1}"

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --port 8080 \
  --timeout 3600 \
  --memory 512Mi \
  --cpu 1 \
  --no-cpu-throttling \
  --execution-environment gen2 \
  --max-instances 4

echo
echo "Open the URL above in Chrome. Default panel password: Ghanizada"
