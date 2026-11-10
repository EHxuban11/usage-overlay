// Retro 8x8 pixel-art glyphs for the panel indicator, one per provider. Hand
// drawn (not brand logos) to keep the flavour recognisable without copying
// anyone's mark. Each grid is 8 rows of 8 chars; '#' = filled pixel.
//
// draw(cr, key, size, rgba) paints the glyph into a Cairo context, e.g. from
// an St.DrawingArea's 'repaint' handler: `icons.draw(cr, 'claude', 16, [0.85, 0.47, 0.34, 1])`.

const GRID = 8;

const GLYPHS = {
    // CLAUDE — a sparkle/burst (Anthropic's mark is a stylised asterisk).
    claude: [
        '...##...',
        '...##...',
        '.#.##.#.',
        '..#..#..',
        '########',
        '..#..#..',
        '.#.##.#.',
        '...##...',
    ],
    // TOKENS — a little ascending bar chart / tally counter.
    tokens: [
        '........',
        '.#......',
        '.#.#....',
        '.#.#.#..',
        '.#.#.#..',
        '.#.#.#..',
        '.#.#.#..',
        '########',
    ],
    // CODEX — a hex nut, nodding to OpenAI's hexagonal knot without copying it.
    codex: [
        '..####..',
        '.#....#.',
        '#..##..#',
        '#.#..#.#',
        '#.#..#.#',
        '#..##..#',
        '.#....#.',
        '..####..',
    ],
    // CURSOR — a mouse pointer.
    cursor: [
        '#.......',
        '##......',
        '#.#.....',
        '#..#....',
        '#...#...',
        '#..###..',
        '#.#..#..',
        '##....#.',
    ],
    // COPILOT — an IC/chip, for an AI "co-pilot" riding along in the hardware.
    copilot: [
        '.######.',
        '#.#..#.#',
        '#......#',
        '#.####.#',
        '#.####.#',
        '#......#',
        '#.#..#.#',
        '.######.',
    ],
    // OPENCD — a terminal prompt.
    opencode: [
        '........',
        '#.......',
        '##......',
        '###.....',
        '##......',
        '#.......',
        '........',
        '.#####..',
    ],
    // OLLAMA — the llama's head: two ears, face, snout.
    ollama: [
        '.#....#.',
        '.#....#.',
        '.######.',
        '#.#..#.#',
        '#......#',
        '#..##..#',
        '#.####.#',
        '.######.',
    ],
    // DEVIN — a little antenna'd robot head, for an autonomous agent.
    devin: [
        '...##...',
        '...##...',
        '.######.',
        '#.#..#.#',
        '#......#',
        '#.####.#',
        '.######.',
        '.#....#.',
    ],
};

// Muted grey for an unknown/loading provider, so a bad key never throws.
const FALLBACK = [
    '........',
    '.######.',
    '.#....#.',
    '.#....#.',
    '.#....#.',
    '.#....#.',
    '.######.',
    '........',
];

export function glyphFor(key) {
    return GLYPHS[key] || FALLBACK;
}

// Paint an 8x8 glyph scaled to fill a `size`x`size` square at (0, 0) in the
// given Cairo context. `rgba` is [r, g, b, a] in 0..1.
export function draw(cr, key, size, rgba) {
    const grid = glyphFor(key);
    const cell = size / GRID;
    cr.setSourceRGBA(rgba[0], rgba[1], rgba[2], rgba[3] ?? 1);
    for (let y = 0; y < GRID; y++) {
        const row = grid[y];
        for (let x = 0; x < GRID; x++) {
            if (row[x] !== '#') continue;
            cr.rectangle(x * cell, y * cell, cell + 0.5, cell + 0.5);
        }
    }
    cr.fill();
}
