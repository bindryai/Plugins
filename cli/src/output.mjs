// Every list/show command supports --json for scripting (BIND-0175's "JSON to show your Stacks
// and Bindings" ask). Human output is a plain fixed-width table; nothing here is a rendering
// framework, on purpose — one function, easy to read, easy to keep in sync with the data.

export function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

export function printTable(rows, columns) {
  if (rows.length === 0) {
    console.log('(none)');
    return;
  }
  const widths = columns.map((col) =>
    Math.max(col.header.length, ...rows.map((row) => String(col.value(row) ?? '').length))
  );
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  console.log(line(columns.map((col) => col.header)));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const row of rows) {
    console.log(line(columns.map((col) => String(col.value(row) ?? ''))));
  }
}
