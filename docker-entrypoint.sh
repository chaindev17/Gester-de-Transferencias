#!/bin/sh
# Ajusta el propietario del volumen de datos y baja privilegios.
# Necesario porque los discos/volúmenes se montan como root, mientras que el
# proceso de la app corre como el usuario sin privilegios «gestor».
set -eu
: "${DATA_DIR:=/app/data}"
mkdir -p "$DATA_DIR"
chown -R gestor:gestor "$DATA_DIR"
chmod 700 "$DATA_DIR"
exec su-exec gestor "$@"
