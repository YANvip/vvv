#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/after-sales-platform"
ZIP_FILE="/opt/after-sales-platform.zip"
STAGE_DIR="/opt/after-sales-platform-stage"
BACKUP_DIR="/opt/after-sales-platform-backup-$(date +%Y%m%d-%H%M%S)"

if [ ! -f "$ZIP_FILE" ]; then
  echo "未找到 $ZIP_FILE"
  exit 1
fi
if [ ! -f "$APP_DIR/infra/.env" ]; then
  echo "未找到服务器现有配置 $APP_DIR/infra/.env，已停止，避免覆盖密码。"
  exit 1
fi

cp -a "$APP_DIR" "$BACKUP_DIR"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
unzip -q -o "$ZIP_FILE" -d "$STAGE_DIR"

cp -a "$STAGE_DIR/apps/." "$APP_DIR/apps/"
cp -a "$STAGE_DIR/docs/." "$APP_DIR/docs/"
cp -a "$STAGE_DIR/infra/docker-compose.yml" "$APP_DIR/infra/docker-compose.yml"
cp -a "$STAGE_DIR/infra/nginx/." "$APP_DIR/infra/nginx/"
cp -a "$STAGE_DIR/infra/initdb/." "$APP_DIR/infra/initdb/"
cp -a "$STAGE_DIR/README.md" "$APP_DIR/README.md"

cd "$APP_DIR/infra"
docker compose up -d
docker compose restart api web
docker compose ps

echo "升级完成。代码备份：$BACKUP_DIR"
