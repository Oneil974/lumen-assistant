#!/usr/bin/env python3
# Vérifie que le site (docs/) est déployable tel quel.
#
# Le piège qui a motivé ce script : three.js était un LIEN SYMBOLIQUE vers
# src/lib/. En local tout marchait ; une fois docs/ copié vers le dépôt public,
# le lien pointait dans le vide et l'orbe du héro disparaissait sans erreur
# visible. On copie donc docs/ ailleurs SANS suivre les liens, puis on vérifie
# que chaque ressource référencée par les pages et par les modules JS existe
# bien dans la copie.
#
#   python3 scripts/check-site-assets.py

import shutil, os, re, tempfile
import sys
root=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(root)
src='docs'; dst=tempfile.mkdtemp()+'/site'
shutil.copytree(src, dst, symlinks=True)
bad=[]
for root,_,files in os.walk(dst):
    for f in files:
        p=os.path.join(root,f)
        if os.path.islink(p) and not os.path.exists(p): bad.append(('lien mort',os.path.relpath(p,dst)))
for page in ['index.html','changelog.html','tutorials.html']:
    html=open(os.path.join(dst,page),encoding='utf-8').read()
    for u in re.findall(r'(?:src|href)="([^"]+)"', html):
        if u.startswith(('http','#','data:','mailto:')): continue
        t=os.path.join(dst,u.split('#')[0].split('?')[0])
        if not os.path.exists(t): bad.append((page,u))
# ressources importées par les modules JS
for js in ['assets/orb.js','assets/lib/three.module.js']:
    p=os.path.join(dst,js)
    body=open(p,encoding='utf-8').read(4000)
    for imp in re.findall(r"from '(\./[^']+)'", body):
        t=os.path.normpath(os.path.join(os.path.dirname(p), imp.split('?')[0]))
        if not os.path.exists(t): bad.append((js,imp))
print('Copie de contrôle :', dst)
if bad:
    print('PROBLÈMES :')
    for b in bad: print('  -', b[0], '→', b[1])
    sys.exit(1)
print('Aucun problème : le site est déployable tel quel.')
