#!/usr/bin/env bash
# Produit un teaser vertical court à partir de la capture réelle de Lumen.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/docs/assets/demo.mov"
OUT_DIR="$ROOT/docs/assets/tutorials"
OUT="$OUT_DIR/lumen-barre-principale-teaser-vertical.mp4"
FONT="/System/Library/Fonts/Supplemental/Arial Bold.ttf"
TITLE="$OUT_DIR/.title.png"
SUBTITLE="$OUT_DIR/.subtitle.png"
BOTTOM="$OUT_DIR/.bottom.png"
END="$OUT_DIR/.end.png"

mkdir -p "$OUT_DIR"

# Images transparentes pour le texte : cette version de FFmpeg n'embarque pas
# drawtext, ce qui garde le rendu identique sur les machines de montage.
magick -size 1080x170 xc:none -font "$FONT" -pointsize 78 -fill white -gravity center -annotate +0-16 'Lumen' "$TITLE"
magick -size 1080x110 xc:none -font "$FONT" -pointsize 35 -fill '#C6D5E8' -gravity center -annotate +0-8 'Votre assistant IA. En local.' "$SUBTITLE"
magick -size 1080x190 xc:none -font "$FONT" -pointsize 39 -fill white -gravity north -annotate +0+12 'Une barre, et tout devient plus simple.' -pointsize 29 -fill '#9FB9D8' -annotate +0+85 'Privé · local · sur votre Mac' "$BOTTOM"
magick -size 1080x100 xc:none -font "$FONT" -pointsize 48 -fill white -gravity center -annotate +0-2 'Posez. Lumen répond.' "$END"

# Le fond reprend la capture (agrandie et floutée) ; la démonstration reste
# intacte au centre et les titres restent dans la zone sûre des réseaux sociaux.
ffmpeg -y -i "$SOURCE" -loop 1 -i "$TITLE" -loop 1 -i "$SUBTITLE" -loop 1 -i "$BOTTOM" -loop 1 -i "$END" -filter_complex "
 [0:v]trim=duration=18,setpts=PTS-STARTPTS,split=2[bgsrc][fgsrc];
 [bgsrc]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:8,eq=brightness=-0.32:saturation=1.15[bg];
 [fgsrc]scale=960:-2,format=rgba[fg];
 [bg][fg]overlay=(W-w)/2:710[base];
 [base][1:v]overlay=0:120:enable='between(t,0,18)'[withtitle];
 [withtitle][2:v]overlay=0:255:enable='between(t,0,18)'[withsub];
 [withsub][3:v]overlay=0:1500:enable='between(t,2,15)'[withbottom];
 [withbottom][4:v]overlay=0:1660:enable='between(t,15,18)',format=yuv420p[v]" \
 -f lavfi -i "aevalsrc=0.025*sin(2*PI*(130+8*sin(2*PI*0.12*t))*t)+0.012*sin(2*PI*260*t):s=48000:d=18" \
 -map "[v]" -map 5:a -shortest -r 30 \
 -c:v libx264 -preset medium -crf 20 -movflags +faststart \
 -c:a aac -b:a 160k "$OUT"

echo "$OUT"
