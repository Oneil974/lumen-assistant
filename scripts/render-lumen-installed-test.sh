#!/usr/bin/env bash
# Transforme une capture de Lumen installé en courte vidéo verticale publiable.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/docs/assets/tutorials"
SHOT="/private/tmp/lumen-screen-test.png"
OUT="$OUT_DIR/lumen-test-vertical.mp4"
FONT="/System/Library/Fonts/Supplemental/Arial Bold.ttf"
TITLE="$OUT_DIR/.installed-title.png"
CTA="$OUT_DIR/.installed-cta.png"

mkdir -p "$OUT_DIR"
magick -size 1080x170 xc:none -font "$FONT" -pointsize 70 -fill white -gravity center -annotate +0-16 'Lumen, à votre écoute.' "$TITLE"
magick -size 1080x120 xc:none -font "$FONT" -pointsize 36 -fill '#C6D5E8' -gravity center -annotate +0-8 'Une IA locale, directement sur votre Mac.' "$CTA"

ffmpeg -y -loop 1 -i "$SHOT" -loop 1 -i "$TITLE" -loop 1 -i "$CTA" -filter_complex "
 [0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:8,eq=brightness=-0.35:saturation=1.08[bg];
 [0:v]crop=1220:760:410:80,scale=980:-2[ui];
 [bg][ui]overlay=(W-w)/2:650[base];
 [base][1:v]overlay=0:130:enable='between(t,0,12)'[withtitle];
 [withtitle][2:v]overlay=0:1510:enable='between(t,1,12)',format=yuv420p[v]" \
 -f lavfi -i "aevalsrc=0.018*sin(2*PI*150*t)+0.009*sin(2*PI*300*t):s=48000:d=12" \
 -map "[v]" -map 3:a -t 12 -r 30 -c:v libx264 -preset medium -crf 20 -movflags +faststart -c:a aac -b:a 160k "$OUT"
echo "$OUT"
