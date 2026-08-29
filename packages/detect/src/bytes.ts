/**
 * A file's size as the Hub shows it (decimal units): MB to one place below a
 * gigabyte, else GB. A file under 0.1 MB says so rather than "0.0 MB", which
 * would read as no file. Its own file, with no imports, because the console's
 * client code reads it too (as `@washtrace/detect/bytes`) and the package's
 * main entry would bring the database driver along. The card and the console
 * say one size for one file.
 */
export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  const mb = n / 1e6;
  return mb < 0.05 ? '<0.1 MB' : `${mb.toFixed(1)} MB`;
}
