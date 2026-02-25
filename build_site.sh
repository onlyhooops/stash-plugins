#!/bin/bash
# AGPLv3.0
# Based on https://github.com/stashapp/plugins-repo-template

# builds a repository of plugins
# outputs to _site with the following structure:
# index.yml
# *.zip
# Each zip file contains the plugin yml and all files in the same directory

outdir="$1"
if [ -z "$outdir" ]; then
  outdir="_site"
fi

rm -rf "$outdir"
mkdir -p "$outdir"

buildPlugin() {
  f=$1
  dir=$(dirname "$f")
  plugin_id=$(basename "$f" .yml)

  echo "Processing $plugin_id"

  version=$(git log -n 1 --pretty=format:%h -- "$dir"/* 2>/dev/null || echo "local")
  updated=$(TZ=UTC0 git log -n 1 --date="format-local:%F %T" --pretty=format:%ad -- "$dir"/* 2>/dev/null || date -u "+%F %T")

  zipfile=$(realpath "$outdir/$plugin_id.zip")

  pushd "$dir" > /dev/null
  zip -r "$zipfile" . > /dev/null
  popd > /dev/null

  name=$(grep "^name:" "$f" | head -n 1 | cut -d' ' -f2- | sed -e 's/\r//' -e 's/^"\(.*\)"$/\1/')
  description=$(grep "^description:" "$f" | head -n 1 | cut -d' ' -f2- | sed -e 's/\r//' -e 's/^"\(.*\)"$/\1/')
  ymlVersion=$(grep "^version:" "$f" | head -n 1 | cut -d' ' -f2- | sed -e 's/\r//' -e 's/^"\(.*\)"$/\1/')
  version="$ymlVersion-$version"
  dep=$(grep "^# requires:" "$f" | cut -c 12- | sed -e 's/\r//')

  {
    echo "- id: $plugin_id"
    echo "  name: $name"
    echo "  metadata:"
    echo "    description: $description"
    echo "  version: $version"
    echo "  date: $updated"
    echo "  path: $plugin_id.zip"
    echo "  sha256: $(sha256sum "$zipfile" | cut -d' ' -f1)"
    if [ -n "$dep" ]; then
      echo "  requires:"
      for d in ${dep//,/ }; do
        echo "    - $d"
      done
    fi
    echo ""
  } >> "$outdir"/index.yml
}

find ./plugins -mindepth 1 -maxdepth 2 -name "*.yml" 2>/dev/null | while read file; do
  buildPlugin "$file"
done
