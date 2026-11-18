"""Recolour the LMS stylesheets (and colour literals in its scripts) to the Timesheet portal's palette (slate neutrals, navy sidebar, blue brand).

Only colours change: every rule, size and layout stays as it is. Each colour keeps its lightness (so contrast is kept)
and moves to the matching Timesheet hue:
  * the LMS brand (yellow/amber) and the old teal accents      -> Timesheet brand blue (#2f5c9e family)
  * charcoal, blue-grey and tinted neutral greys/creams         -> Timesheet slate greys (#1e293b ... #f8fafc)
  * status colours keep their meaning: red (errors), orange (warnings), saturated green (passed/success),
    and the decorative violet/indigo stat accents are left unchanged.

Run from the repository's lms/ folder:  python frontend/tools/apply_timesheet_palette.py
then regenerate the dark theme:          npm run theme:dark
The script is idempotent: Timesheet colours already map to themselves (or very close).
"""
import colorsys
import re
from pathlib import Path

STYLES = Path(__file__).resolve().parents[1] / 'public/styles'
SCRIPTS = STYLES.parent / 'scripts'  # colour literals in charts and inline styles
COLOR = re.compile(r'#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b')
RGBA = re.compile(r'rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+%?)\s*)?\)')
BRAND_HUE = 215 / 360
BRAND_MAX_SAT = 0.55
# Tailwind slate (the Timesheet neutrals): (lightness, saturation) pairs to interpolate the tint of a grey.
SLATE = [(0.06, 0.47), (0.17, 0.33), (0.27, 0.25), (0.35, 0.19), (0.47, 0.16), (0.65, 0.20), (0.84, 0.27), (0.91, 0.32), (0.96, 0.40), (0.98, 0.43)]


def parse(text):
    h = text[1:]
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    rgb = tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return rgb, h[6:8] if len(h) == 8 else ''


def slate_saturation(lightness):
    for (l1, s1), (l2, s2) in zip(SLATE, SLATE[1:]):
        if lightness <= l2:
            t = 0 if l2 == l1 else max(0.0, (lightness - l1) / (l2 - l1))
            return s1 + (s2 - s1) * t
    return SLATE[-1][1]


def target(hue, lightness, saturation):
    """'brand', 'slate' or None (keep) for a colour."""
    deg = hue * 360
    if saturation < 0.02 or lightness >= 0.995 or lightness <= 0.01:
        return None                                    # pure white / black / grey
    if deg < 15 or deg >= 345 or 15 <= deg < 36:
        return None if saturation >= 0.25 else 'slate'  # red errors, orange warnings
    if 36 <= deg < 66:
        return 'brand' if saturation >= 0.25 else 'slate'  # the LMS yellow/amber brand
    if 66 <= deg < 165:
        # Saturated greens are success states; washed-out green-greys were the old theme's neutrals.
        return None if saturation >= 0.30 and not (lightness > 0.9 and saturation < 0.45) else 'slate'
    if 165 <= deg < 205:
        # The old teal brand accents become the blue brand; teal-dark surfaces and blue-greys become slate.
        return 'brand' if saturation >= 0.5 and 0.2 < lightness < 0.7 else 'slate'
    if 205 <= deg < 225:
        return 'slate' if saturation < 0.3 else None   # already slate-blue
    return None                                        # violet / indigo decorative accents


# The Timesheet's own colours (Tailwind slate, its sidebar and brand tokens) are already right and are never changed.
TIMESHEET = {'f8fafc', 'f1f5f9', 'e2e8f0', 'cbd5e1', '94a3b8', '64748b', '475569', '334155', '1e293b', '0f172a',
             '273449', '2c3a50', 'eef4fb', 'd9e6f5', 'b6cdea', '3b6db3', '2f5c9e', '274c83'}


def convert(r, g, b):
    """The Timesheet colour (0-255 ints) for an LMS colour, or None to keep it."""
    if f'{r:02x}{g:02x}{b:02x}' in TIMESHEET:
        return None
    hue, lightness, saturation = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    kind = target(hue, lightness, saturation)
    if kind is None:
        return None
    sat = min(saturation, BRAND_MAX_SAT) if kind == 'brand' else slate_saturation(lightness)
    return tuple(round(v * 255) for v in colorsys.hls_to_rgb(BRAND_HUE, lightness, sat))


def remap(text):
    (r, g, b), alpha = parse(text)
    new = convert(round(r * 255), round(g * 255), round(b * 255))
    return text if new is None else '#' + ''.join(f'{v:02x}' for v in new) + alpha


def remap_rgba(match):
    new = convert(*(int(match.group(i)) for i in (1, 2, 3)))
    if new is None:
        return match.group(0)
    alpha = match.group(4)
    return f'rgba({new[0]},{new[1]},{new[2]},{alpha})' if alpha is not None else f'rgb({new[0]},{new[1]},{new[2]})'


def main():
    changed = 0
    for path in sorted(STYLES.glob('*.css')) + sorted(SCRIPTS.glob('*.js')):
        with open(path, encoding='utf-8', newline='') as handle:  # keep the files' line endings
            source = handle.read()
        result = RGBA.sub(remap_rgba, COLOR.sub(lambda m: remap(m.group(0)), source))
        if result != source:
            path.write_text(result, encoding='utf-8', newline='')
            changed += 1
            print(f'recoloured {path.name}')
    print(f'{changed} file(s) updated')


if __name__ == '__main__':
    main()
