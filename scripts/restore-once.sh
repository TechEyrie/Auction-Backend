#!/bin/sh
set -e
FLAG=/srv/araqandkahraman/env/MONGO_RESTORE_DONE
DUMP=/srv/araqandkahraman/backend/backup/araq_kahraman
if [ -f "$FLAG" ]; then echo "skip restore: already done"; exit 0; fi
if [ ! -d "$DUMP" ]; then echo "skip restore: no dump at $DUMP"; exit 0; fi
docker run --rm --network backend_default -v "$DUMP:/backup:ro" mongo:7 mongorestore --uri='mongodb://mongo:27017/araq_kahraman?replicaSet=rs0' --dir=/backup
date -u > "$FLAG"
echo "restore done; flag $FLAG"
