#!/usr/bin/env bash
# Interactive deploy to Cloud Run. Run from Google Cloud Shell:  ./deploy.sh
#
# You will be asked for region, CPU and memory from numbered lists.
# Press Enter to accept the default (shown in brackets), or type a number.
#
# Skip any question by setting a variable first, for example:
#   REGION=europe-west1 CPU=1 MEMORY=512Mi ./deploy.sh
# Other options:
#   SERVICE=my-panel      service name            (default: ghanizada-panel)
#   MAX_INSTANCES=4       maximum instances       (default: 4)
#   DRY_RUN=1             show what would run, deploy nothing
set -euo pipefail

# If anything fails, say where
trap 'echo; echo "Stopped at line $LINENO (exit code $?). Nothing was deployed." >&2' ERR

SERVICE="${SERVICE:-ghanizada-panel}"
MAX_INSTANCES="${MAX_INSTANCES:-4}"

# Answers come from the terminal. INPUT is only for testing with a file.
if [ -n "${INPUT:-}" ]; then exec < "$INPUT"; fi

# Cloud Run regions. Update this list if Google adds new ones.
REGION_LIST=(
  asia-east1 asia-east2 asia-northeast1 asia-northeast2 asia-northeast3
  asia-south1 asia-south2 asia-southeast1 asia-southeast2
  australia-southeast1 australia-southeast2
  europe-central2 europe-north1 europe-southwest1 europe-west1 europe-west2
  europe-west3 europe-west4 europe-west6 europe-west8 europe-west9 europe-west12
  me-central1 me-central2 me-west1
  northamerica-northeast1 northamerica-northeast2
  southamerica-east1 southamerica-west1
  us-central1 us-east1 us-east4 us-east5 us-south1 us-west1 us-west2 us-west3 us-west4
)

CPU_VALUES=(0.5 1 2 4)
CPU_LABELS=(
  "0.5 vCPU  - cheapest, memory limited to 512Mi"
  "1 vCPU    - recommended"
  "2 vCPU    - more throughput"
  "4 vCPU    - heavy traffic"
)

MEM_VALUES=(256Mi 512Mi 1Gi 2Gi 4Gi 8Gi)
MEM_MB=(256 512 1024 2048 4096 8192)

# ---------- helpers ----------

# ask PROMPT -> prints the answer (empty if none)
ask() {
  local v=""
  printf '%s' "$1" >&2
  read -r v || v=""
  printf '%s\n' "$v"
}

# choose TITLE DEFAULT_NUMBER ITEM...   -> sets CHOICE (0-based index)
choose() {
  local title="$1" def="$2"; shift 2
  local n=$# items=("$@") i ans mark
  echo
  echo "$title"
  for i in "${!items[@]}"; do
    mark=""
    [ $((i + 1)) -eq "$def" ] && mark="   <- default"
    printf "  %3d) %s%s\n" $((i + 1)) "${items[$i]}" "$mark"
  done
  while true; do
    ans="$(ask "Enter a number [$def]: ")"
    ans="${ans:-$def}"
    if [[ "$ans" =~ ^[0-9]+$ ]] && (( ans >= 1 && ans <= n )); then
      CHOICE=$((ans - 1)); return 0
    fi
    for i in "${!items[@]}"; do
      if [ "$ans" = "${items[$i]}" ]; then CHOICE=$i; return 0; fi
    done
    echo "  Please enter a number from 1 to $n."
  done
}

# find_index VALUE ITEM...  -> prints 1-based position of VALUE, or 1 if missing
find_index() {
  local want="$1" i=0 item; shift
  for item in "$@"; do
    i=$((i + 1))
    if [ "$item" = "$want" ]; then echo "$i"; return; fi
  done
  echo 1
}

# Wrap commands so DRY_RUN=1 only prints them
run() {
  if [ -n "${DRY_RUN:-}" ]; then echo "[dry run] $*"; else "$@"; fi
}

# ---------- 1. project ----------
if [ -z "${DRY_RUN:-}" ]; then
  PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
  if [ -z "$PROJECT" ] || [ "$PROJECT" = "(unset)" ]; then
    echo "No Google Cloud project is selected. Run this first, then deploy again:"
    echo "  gcloud config set project YOUR_PROJECT_ID"
    exit 1
  fi
  echo "Project: $PROJECT"
fi

# ---------- 2. region ----------
if [ -z "${REGION:-}" ]; then
  choose "Choose a region for Cloud Run:" \
    "$(find_index us-central1 "${REGION_LIST[@]}")" "${REGION_LIST[@]}"
  REGION="${REGION_LIST[$CHOICE]}"
fi

# ---------- 3. CPU ----------
if [ -z "${CPU:-}" ]; then
  choose "Choose CPU per instance:" \
    "$(find_index 1 "${CPU_VALUES[@]}")" "${CPU_LABELS[@]}"
  CPU="${CPU_VALUES[$CHOICE]}"
fi

# ---------- 4. memory (limited by the CPU you chose) ----------
case "$CPU" in
  0.5) cap=512 ;;
  1)   cap=4096 ;;
  2)   cap=8192 ;;
  4)   cap=16384 ;;
  *)   cap=32768 ;;
esac
ALLOWED_MEM=()
for i in "${!MEM_VALUES[@]}"; do
  [ "${MEM_MB[$i]}" -le "$cap" ] && ALLOWED_MEM+=("${MEM_VALUES[$i]}")
done

if [ -z "${MEMORY:-}" ]; then
  choose "Choose RAM per instance (available with $CPU vCPU):" \
    "$(find_index 512Mi "${ALLOWED_MEM[@]}")" "${ALLOWED_MEM[@]}"
  MEMORY="${ALLOWED_MEM[$CHOICE]}"
fi

# ---------- 5. confirm ----------
echo
echo "Ready to deploy:"
echo "  Service : $SERVICE"
echo "  Region  : $REGION"
echo "  CPU     : $CPU vCPU"
echo "  RAM     : $MEMORY"
echo "  Max instances: $MAX_INSTANCES"
ans="$(ask "Deploy now? [Y/n]: ")"
case "${ans:-y}" in
  y|Y|yes|YES) ;;
  *) echo "Cancelled."; exit 0 ;;
esac

# ---------- 6. deploy ----------
echo
echo "Enabling Google Cloud services (this can take a minute)..."
run gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

echo "Deploying $SERVICE to $REGION. Building the container takes a few minutes..."
run gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --port 8080 \
  --timeout 3600 \
  --cpu "$CPU" \
  --memory "$MEMORY" \
  --no-cpu-throttling \
  --execution-environment gen2 \
  --max-instances "$MAX_INSTANCES"

if [ -z "${DRY_RUN:-}" ]; then
  URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)' 2>/dev/null || true)"
  echo
  echo "Done. Service URL: ${URL:-run: gcloud run services describe $SERVICE --region $REGION}"
  echo "Open it in Chrome and sign in with password: Ghanizada"
  echo "Change it later with: gcloud run services update $SERVICE --region $REGION --update-env-vars PANEL_PASSWORD=NewPassword"
fi
