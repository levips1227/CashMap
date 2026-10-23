#!/usr/bin/env bash
# Ubuntu production helper. Run with bash; does not require executable permissions.
set -euo pipefail
umask 077
project=/home/ubuntu/CashMap
backups=/home/ubuntu/cashmap-backups
action=${1:-backup}

usage() {
  echo 'Usage: bash scripts/cashmapBackup.sh backup|list|restore BACKUP.tar.gz'
}

case "$action" in
  list)
    ls -lh "$backups"/*.tar.gz
    exit
    ;;
  backup)
    mkdir -p "$backups"
    chmod 700 "$backups"
    archive="$backups/CashMap-$(date +%Y%m%d-%H%M%S)-$$.tar.gz"
    sudo systemctl stop cashmap
    trap 'sudo systemctl start cashmap' EXIT
    tar -czpf "$archive" -C /home/ubuntu CashMap
    gzip -t "$archive"
    tar -dzf "$archive" -C /home/ubuntu
    diff -u \
      <(cd /home/ubuntu && find CashMap -print | LC_ALL=C sort) \
      <(tar -tzf "$archive" | sed 's:/$::' | LC_ALL=C sort)
    sha256sum "$archive" > "$archive.sha256"
    echo "PASS: verified backup: $archive"
    ;;
  restore)
    filename=${2:-}
    case "$filename" in
      ''|*/*|*\\*|.|..) usage; exit 1 ;;
      CashMap-*.tar.gz) ;;
      *) usage; exit 1 ;;
    esac
    archive="$backups/$filename"
    # Check everything possible before stopping the service or moving the project.
    sha256sum -c "$archive.sha256"
    gzip -t "$archive"
    tar -tzf "$archive" >/dev/null
    [ -d "$project" ] || { echo "Project not found: $project"; exit 1; }
    saved="/home/ubuntu/CashMap-before-restore-$(date +%Y%m%d-%H%M%S)-$$"
    failed="${saved}-failed-extraction"
    [ ! -e "$saved" ] && [ ! -e "$failed" ]
    sudo systemctl stop cashmap
    moved=false
    complete=false
    finish_restore() {
      result=$?
      trap - EXIT
      if [ "$moved" = true ] && [ "$complete" = false ]; then
        echo 'Restore failed; putting the previous installation back.' >&2
        if [ -e "$project" ]; then
          mv -- "$project" "$failed" || exit 1
        fi
        mv -- "$saved" "$project" || exit 1
      fi
      sudo systemctl start cashmap || exit 1
      exit "$result"
    }
    trap finish_restore EXIT
    mv -- "$project" "$saved"
    moved=true
    tar -xzpf "$archive" -C /home/ubuntu
    tar -dzf "$archive" -C /home/ubuntu
    complete=true
    echo "PASS: restored $archive"
    echo "Previous installation preserved at: $saved"
    ;;
  *) usage; exit 1 ;;
esac
