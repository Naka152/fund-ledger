#!/bin/sh
# 把本机代码同步到服务器并重启服务（服务器上的 data/ 不会被覆盖）
# 用法：SERVER=root@你的服务器IP ./deploy/deploy.sh     （也可以写 ~/.ssh/config 里的主机名）
set -e
: "${SERVER:?请先指定服务器，例如：SERVER=root@1.2.3.4 ./deploy/deploy.sh}"
DEST=${DEST:-/opt/fund-ledger}
cd "$(dirname "$0")/.."
rsync -az --delete --exclude '__pycache__' --exclude '.git' server web deploy "$SERVER:$DEST/"
ssh "$SERVER" "chown -R fundledger:fundledger $DEST && systemctl restart fund-ledger && sleep 1 && systemctl is-active fund-ledger"
