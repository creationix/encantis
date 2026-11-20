#!/bin/sh
# usage: runcorpus.sh name=LOWER ...   -> corpus/<name>.jsonl (skips existing); CC=final/cc
cd <scratch>
for arg in "$@"; do
  name=${arg%%=*}; L=${arg#*=}
  [ -s corpus/$name.jsonl ] && continue
  start=$(date +%s)
  LOWER=$L CC=$PWD/cc bun tools/corpus.ts > corpus/$name.tmp && mv corpus/$name.tmp corpus/$name.jsonl
  echo "done $name $(( $(date +%s) - start ))s"
done
echo ALLDONE
