/**
 * `wp_cursor_shape_v1` shapes → CSS `cursor` values.
 *
 * The protocol was deliberately modelled on CSS, so with two exceptions the
 * name *is* the CSS keyword with underscores turned into hyphens. Writing the
 * table out longhand would be forty lines that could drift; deriving it cannot.
 */
const SHAPE_NAMES = [
  'default', 'context_menu', 'help', 'pointer', 'progress', 'wait', 'cell',
  'crosshair', 'text', 'vertical_text', 'alias', 'copy', 'move', 'no_drop',
  'not_allowed', 'grab', 'grabbing', 'e_resize', 'n_resize', 'ne_resize',
  'nw_resize', 's_resize', 'se_resize', 'sw_resize', 'w_resize', 'ew_resize',
  'ns_resize', 'nesw_resize', 'nwse_resize', 'col_resize', 'row_resize',
  'all_scroll', 'zoom_in', 'zoom_out',
  // The last two have no CSS equivalent, so they borrow the nearest one.
  'dnd_ask', 'all_resize',
];

const NOT_IN_CSS: Record<string, string> = {
  dnd_ask: 'default',
  all_resize: 'move',
};

/** Shape 0 is not a protocol value; the compositor uses it for "hidden". */
export function cssCursor(shape: number): string {
  if (shape === 0) return 'none';
  const name = SHAPE_NAMES[shape - 1];
  if (!name) return 'default';
  return NOT_IN_CSS[name] ?? name.replace(/_/g, '-');
}
