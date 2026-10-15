// Boîtier « Lumen Pi » — Raspberry Pi 4 B / 5, paramétrique.
//
// Deux finitions, dans la même grammaire que l'habillage de Lumen Pro :
// noir profond, et un métal qui SOULIGNE — ici une plaque d'insert et un
// liseré, pas une coque colorée. Le boîtier s'imprime en deux ou trois pièces
// selon la finition choisie.
//
//   FLAVOR = "gold"  → insert or, gravure « LUMEN » en creux
//   FLAVOR = "red"   → insert rouge métal, même géométrie
//
// L'impression bicolore ne demande aucune imprimante multi-matière : la coque
// et l'insert sont deux pièces distinctes, imprimées séparément dans deux
// filaments, puis clipsées. C'est le procédé le plus simple qui donne le
// résultat — et le seul qui reste réparable (un insert rayé se réimprime seul).
//
// Rendu :
//   openscad -D 'PART="shell"'  -o lumen-pi-shell.stl  lumen-pi-case.scad
//   openscad -D 'PART="lid"'    -o lumen-pi-lid.stl    lumen-pi-case.scad
//   openscad -D 'PART="insert"' -o lumen-pi-insert.stl lumen-pi-case.scad
//   openscad -D 'PART="all"'    lumen-pi-case.scad          (aperçu assemblé)
//
// Impression conseillée : PETG ou ASA (le Pi chauffe ; le PLA flue à 60 °C),
// buse 0,4 mm, couches 0,2 mm, 3 parois, 20 % de remplissage. Aucun support :
// tous les surplombs sont chanfreinés à 45°.

/* [Choix] */
// Modèle de carte
BOARD = "pi5";      // "pi4" | "pi5"
// Finition
FLAVOR = "gold";    // "gold" | "red"
// Pièce à produire
PART = "all";       // "shell" | "lid" | "insert" | "all"

/* [Ajustements d'impression] */
// Jeu entre pièces qui s'emboîtent. Augmentez si votre imprimante « grossit ».
CLEARANCE = 0.25;
// Épaisseur des parois.
WALL = 2.4;
// Épaisseur du fond et du couvercle.
FLOOR = 2.0;

$fn = 64;

// ---------------------------------------------------------------------------
// Cotes de la carte. Elles viennent de la mécanique officielle du Raspberry Pi :
// 85 × 56 mm, trous de fixation Ø2,7 à 3,5 mm des bords, entraxe 58 × 49 mm.
// Le Pi 5 déplace ses connecteurs — d'où les deux jeux d'ouvertures.
// ---------------------------------------------------------------------------
BOARD_L = 85;
BOARD_W = 56;
BOARD_T = 1.6;
HOLE_D = 2.7;
HOLE_INSET = 3.5;
HOLE_DX = 58;
HOLE_DY = 49;

// Hauteur libre au-dessus de la carte : le connecteur Ethernet culmine à
// ~13,5 mm, le GPIO à ~8,5 mm. On garde 16 mm pour laisser passer l'air.
CAVITY_H = 16;
// Hauteur des entretoises : sépare la carte du fond, laisse passer l'air sous
// elle et évite que les soudures touchent le plastique.
STANDOFF_H = 4;

INNER_L = BOARD_L + 2 * CLEARANCE;
INNER_W = BOARD_W + 2 * CLEARANCE;
OUTER_L = INNER_L + 2 * WALL;
OUTER_W = INNER_W + 2 * WALL;
OUTER_H = FLOOR + STANDOFF_H + BOARD_T + CAVITY_H;
CORNER_R = 3.5;

// Couleurs d'aperçu — elles ne changent rien au STL, elles disent seulement
// quelle pièce s'imprime dans quel filament.
METAL = (FLAVOR == "red") ? [0.80, 0.14, 0.27] : [0.89, 0.71, 0.29];
BLACK = [0.09, 0.09, 0.10];

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

// Boîte à coins arrondis, posée sur le plan Z=0.
module rbox(l, w, h, r) {
    hull() for (x = [r, l - r], y = [r, w - r]) translate([x, y, 0]) cylinder(r = r, h = h);
}

// Fente d'aération en losange : elle s'imprime sans support, contrairement à un
// cercle ou à un rectangle large.
module vent_slot(len, wid, h) {
    linear_extrude(height = h) polygon([[0, wid / 2], [wid / 2, 0], [len - wid / 2, 0], [len, wid / 2], [len - wid / 2, wid], [wid / 2, wid]]);
}

// Grille d'aération sous la carte : l'air entre par le fond, ressort par les
// côtés. Sans elle, un Pi 5 sous charge se met en throttling en boîtier fermé.
module floor_vents() {
    rows = 5;
    cols = 9;
    for (i = [0 : rows - 1], j = [0 : cols - 1])
        translate([14 + j * 7, 12 + i * 7.5, -1])
            vent_slot(5, 2.4, FLOOR + 2);
}

// Entretoise + trou de vis M2,5. Le trou est borgne : une vis M2,5×6 y mord
// directement dans le plastique, sans insert laiton (qu'on n'a pas toujours).
module standoff() {
    difference() {
        cylinder(d = 6.2, h = STANDOFF_H);
        translate([0, 0, 1]) cylinder(d = 2.3, h = STANDOFF_H);
    }
}

module standoffs() {
    for (x = [HOLE_INSET, HOLE_INSET + HOLE_DX], y = [HOLE_INSET, HOLE_INSET + HOLE_DY])
        translate([WALL + CLEARANCE + x, WALL + CLEARANCE + y, FLOOR]) standoff();
}

// ---------------------------------------------------------------------------
// Ouvertures des connecteurs
//
// Elles sont volontairement 0,6 mm plus larges que les cotes officielles : une
// prise réseau qui force sur un bord imprimé finit par le fendre.
// ---------------------------------------------------------------------------
module cutouts() {
    z0 = FLOOR + STANDOFF_H + BOARD_T;   // dessus de la carte
    slack = 0.6;

    // --- Côté long : USB et Ethernet (X = OUTER_L) ---
    // Le Pi 5 place l'Ethernet à l'opposé du Pi 4 : la position dépend du modèle.
    eth_y = (BOARD == "pi5") ? 45.0 : 10.25;
    usb1_y = (BOARD == "pi5") ? 27.0 : 29.0;
    usb2_y = (BOARD == "pi5") ? 9.0  : 47.0;

    translate([OUTER_L - WALL - 1, WALL + eth_y - 8, z0 - 1])
        cube([WALL + 2, 16 + slack, 14 + slack]);
    for (y = [usb1_y, usb2_y])
        translate([OUTER_L - WALL - 1, WALL + y - 7, z0 - 1])
            cube([WALL + 2, 14 + slack, 16 + slack]);

    // --- Côté court : alimentation USB-C, deux micro-HDMI (Y = 0) ---
    translate([WALL + 3.5, -1, z0 - 1]) cube([11 + slack, WALL + 2, 6 + slack]);
    for (x = [22, 35.5])
        translate([WALL + x, -1, z0 - 1]) cube([8 + slack, WALL + 2, 6.5 + slack]);
    // Prise jack / sortie composite (Pi 4 seulement).
    if (BOARD == "pi4")
        translate([WALL + 51, -1, z0 - 1]) cube([9 + slack, WALL + 2, 7 + slack]);

    // --- Carte microSD (X = 0), fente basse ---
    translate([-1, WALL + 20, FLOOR + 1]) cube([WALL + 2, 15, 4]);

    // --- GPIO : une fenêtre sur le dessus, pour les nappes ---
    translate([WALL + 3, WALL + 47.5, OUTER_H - FLOOR - 1])
        cube([52, 6.5, FLOOR + 2]);

    // --- Aérations latérales ---
    for (i = [0 : 6])
        translate([WALL + 16 + i * 8, -1, FLOOR + 6]) rotate([-90, 0, 0]) vent_slot(9, 2.6, WALL + 2);
    for (i = [0 : 6])
        translate([WALL + 16 + i * 8, OUTER_W + 1, FLOOR + 6]) rotate([90, 0, 0]) vent_slot(9, 2.6, WALL + 2);
}

// ---------------------------------------------------------------------------
// Logement de l'insert métal, sur le couvercle
//
// L'insert est une plaque de 2 mm encastrée en biais dans le couvercle. Le biais
// n'est pas décoratif : il donne à la pièce une orientation d'impression où la
// gravure sort nette, et il rappelle l'entaille d'angle de l'habillage Pro.
// ---------------------------------------------------------------------------
INSERT_L = 46;
INSERT_W = 13;
INSERT_T = 2.0;
INSERT_X = 20;
INSERT_Y = 20;

module insert_pocket(extra = 0) {
    translate([INSERT_X - extra, INSERT_Y - extra, -0.1])
        rbox(INSERT_L + 2 * extra, INSERT_W + 2 * extra, INSERT_T + 0.2 + extra, 2);
}

// « LUMEN », en creux dans l'insert. Une gravure en CREUX plutôt qu'en relief :
// elle ne s'écaille pas, et elle s'imprime sans pont.
module wordmark(depth) {
    translate([INSERT_L / 2, INSERT_W / 2, INSERT_T - depth + 0.01])
        linear_extrude(height = depth + 0.1)
            text("LUMEN", size = 7.2, halign = "center", valign = "center",
                 font = "DejaVu Sans:style=Bold", spacing = 1.18);
}

// ---------------------------------------------------------------------------
// Pièces
// ---------------------------------------------------------------------------

module shell() {
    color(BLACK) difference() {
        rbox(OUTER_L, OUTER_W, OUTER_H, CORNER_R);
        // Cavité intérieure
        translate([WALL, WALL, FLOOR]) rbox(INNER_L, INNER_W, OUTER_H, CORNER_R - WALL / 2);
        cutouts();
        floor_vents();
        // Rainure du couvercle : le couvercle vient s'y encliqueter.
        translate([WALL / 2, WALL / 2, OUTER_H - 1.6])
            rbox(OUTER_L - WALL, OUTER_W - WALL, 2, CORNER_R);
    }
    standoffs();
}

module lid() {
    color(BLACK) difference() {
        union() {
            rbox(OUTER_L, OUTER_W, FLOOR, CORNER_R);
            // Lèvre d'emboîtement, avec le jeu d'impression.
            translate([WALL / 2 + CLEARANCE, WALL / 2 + CLEARANCE, -1.4])
                rbox(OUTER_L - WALL - 2 * CLEARANCE, OUTER_W - WALL - 2 * CLEARANCE, 1.4, CORNER_R);
        }
        // Logement de l'insert (avec jeu) et aérations du couvercle.
        insert_pocket(CLEARANCE);
        for (i = [0 : 5], j = [0 : 3])
            translate([OUTER_L - 30 + 0, 8 + j * 8, -1]) vent_slot(20, 2.6, FLOOR + 2);
    }
}

module insert() {
    color(METAL) difference() {
        translate([INSERT_X, INSERT_Y, 0]) rbox(INSERT_L, INSERT_W, INSERT_T, 2);
        translate([INSERT_X, INSERT_Y, 0]) wordmark(0.6);
    }
}

// ---------------------------------------------------------------------------
// Sortie
// ---------------------------------------------------------------------------

if (PART == "shell") shell();
else if (PART == "lid") lid();
else if (PART == "insert") translate([-INSERT_X, -INSERT_Y, 0]) insert();
else {
    // Aperçu assemblé : le couvercle est écarté pour qu'on voie l'intérieur.
    shell();
    translate([0, 0, OUTER_H + 14]) { lid(); insert(); }
}
