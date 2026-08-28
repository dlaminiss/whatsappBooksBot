const db = require('./db');

// ---------------------------------------------------------------------------
// Tool schemas exposed to Claude (Anthropic tool-use format)
// ---------------------------------------------------------------------------
const toolSchemas = [
  {
    name: 'add_author',
    description:
      'Add a new author to the database, or update an existing author with the same name. Use this before add_book if the author might not exist yet — add_book will also auto-create the author if needed, so this is mainly for adding bio/born details.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Full name of the author' },
        bio: { type: 'string', description: 'Short biography (optional)' },
        born: { type: 'string', description: 'Birth year or date (optional)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_book',
    description:
      'Add a new book to the database. If the given author does not exist yet, they will be created automatically. If the book (same title + author) already exists, its fields will be updated instead of creating a duplicate.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title of the book' },
        author_name: { type: 'string', description: 'Full name of the author' },
        published_year: { type: 'integer', description: 'Year first published (optional)' },
        genre: { type: 'string', description: 'Genre, e.g. "Fiction", "Sci-Fi" (optional)' },
        isbn: { type: 'string', description: 'ISBN (optional)' },
      },
      required: ['title', 'author_name'],
    },
  },
  {
    name: 'update_book',
    description: 'Update fields on an existing book, identified by its current title (and optionally author, to disambiguate).',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Current title of the book to update' },
        author_name: { type: 'string', description: 'Author name, to disambiguate if multiple books share a title (optional)' },
        new_title: { type: 'string', description: 'New title (optional)' },
        new_author_name: { type: 'string', description: 'New/different author (optional)' },
        published_year: { type: 'integer', description: 'New published year (optional)' },
        genre: { type: 'string', description: 'New genre (optional)' },
        isbn: { type: 'string', description: 'New ISBN (optional)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'delete_book',
    description: 'Delete a book from the database by title (and optionally author, to disambiguate). Always confirm with the user in your reply after doing this.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title of the book to delete' },
        author_name: { type: 'string', description: 'Author name, to disambiguate if needed (optional)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'delete_author',
    description: 'Delete an author from the database by name. Their books will remain but with no linked author. Use with caution and confirm with the user first if the request is ambiguous.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the author to delete' },
      },
      required: ['name'],
    },
  },
  {
    name: 'run_sql_select',
    description:
      'Run a read-only SQL SELECT query against the database to answer any question (lookups, joins, counts, filters, sorting, etc). Schema: authors(id, name, bio, born); books(id, title, author_id, published_year, genre, isbn). Join books.author_id = authors.id. Only SELECT statements are allowed.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A single valid SQLite SELECT statement.' },
      },
      required: ['query'],
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findOrCreateAuthor(name) {
  const existing = db.prepare('SELECT * FROM authors WHERE name = ? COLLATE NOCASE').get(name);
  if (existing) return existing;
  const info = db.prepare('INSERT INTO authors (name) VALUES (?)').run(name);
  return db.prepare('SELECT * FROM authors WHERE id = ?').get(info.lastInsertRowid);
}

function isSafeSelect(query) {
  const trimmed = query.trim().replace(/;+\s*$/, ''); // strip trailing semicolon(s)
  if (/;/.test(trimmed)) return false; // no stacked statements
  if (!/^select\b/i.test(trimmed)) return false;
  const forbidden = /\b(insert|update|delete|drop|alter|attach|detach|pragma|create|replace|vacuum)\b/i;
  if (forbidden.test(trimmed)) return false;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Tool executors — called by the agent loop
// ---------------------------------------------------------------------------

function add_author({ name, bio, born }) {
  const existing = db.prepare('SELECT * FROM authors WHERE name = ? COLLATE NOCASE').get(name);
  if (existing) {
    db.prepare('UPDATE authors SET bio = COALESCE(?, bio), born = COALESCE(?, born) WHERE id = ?').run(
      bio || null,
      born || null,
      existing.id
    );
    return { status: 'updated', author: db.prepare('SELECT * FROM authors WHERE id = ?').get(existing.id) };
  }
  const info = db.prepare('INSERT INTO authors (name, bio, born) VALUES (?, ?, ?)').run(name, bio || null, born || null);
  return { status: 'created', author: db.prepare('SELECT * FROM authors WHERE id = ?').get(info.lastInsertRowid) };
}

function add_book({ title, author_name, published_year, genre, isbn }) {
  const author = findOrCreateAuthor(author_name);
  const existing = db
    .prepare('SELECT * FROM books WHERE title = ? COLLATE NOCASE AND author_id = ?')
    .get(title, author.id);

  if (existing) {
    db.prepare(
      'UPDATE books SET published_year = COALESCE(?, published_year), genre = COALESCE(?, genre), isbn = COALESCE(?, isbn) WHERE id = ?'
    ).run(published_year ?? null, genre || null, isbn || null, existing.id);
    return {
      status: 'updated',
      book: db.prepare('SELECT * FROM books WHERE id = ?').get(existing.id),
      author,
    };
  }

  const info = db
    .prepare('INSERT INTO books (title, author_id, published_year, genre, isbn) VALUES (?, ?, ?, ?, ?)')
    .run(title, author.id, published_year ?? null, genre || null, isbn || null);

  return {
    status: 'created',
    book: db.prepare('SELECT * FROM books WHERE id = ?').get(info.lastInsertRowid),
    author,
  };
}

function update_book({ title, author_name, new_title, new_author_name, published_year, genre, isbn }) {
  let row;
  if (author_name) {
    row = db
      .prepare(
        `SELECT books.* FROM books JOIN authors ON authors.id = books.author_id
         WHERE books.title = ? COLLATE NOCASE AND authors.name = ? COLLATE NOCASE`
      )
      .get(title, author_name);
  } else {
    row = db.prepare('SELECT * FROM books WHERE title = ? COLLATE NOCASE').get(title);
  }

  if (!row) return { status: 'not_found', title, author_name: author_name || null };

  let newAuthorId = row.author_id;
  if (new_author_name) {
    newAuthorId = findOrCreateAuthor(new_author_name).id;
  }

  db.prepare(
    `UPDATE books SET
       title = COALESCE(?, title),
       author_id = ?,
       published_year = COALESCE(?, published_year),
       genre = COALESCE(?, genre),
       isbn = COALESCE(?, isbn)
     WHERE id = ?`
  ).run(new_title || null, newAuthorId, published_year ?? null, genre || null, isbn || null, row.id);

  return { status: 'updated', book: db.prepare('SELECT * FROM books WHERE id = ?').get(row.id) };
}

function delete_book({ title, author_name }) {
  let row;
  if (author_name) {
    row = db
      .prepare(
        `SELECT books.* FROM books JOIN authors ON authors.id = books.author_id
         WHERE books.title = ? COLLATE NOCASE AND authors.name = ? COLLATE NOCASE`
      )
      .get(title, author_name);
  } else {
    row = db.prepare('SELECT * FROM books WHERE title = ? COLLATE NOCASE').get(title);
  }
  if (!row) return { status: 'not_found', title, author_name: author_name || null };
  db.prepare('DELETE FROM books WHERE id = ?').run(row.id);
  return { status: 'deleted', book: row };
}

function delete_author({ name }) {
  const row = db.prepare('SELECT * FROM authors WHERE name = ? COLLATE NOCASE').get(name);
  if (!row) return { status: 'not_found', name };
  db.prepare('DELETE FROM authors WHERE id = ?').run(row.id);
  return { status: 'deleted', author: row };
}

function run_sql_select({ query }) {
  const safe = isSafeSelect(query);
  if (!safe) {
    return { error: 'Only a single read-only SELECT statement is allowed.' };
  }
  try {
    const rows = db.prepare(safe).all();
    return { rows };
  } catch (err) {
    return { error: err.message };
  }
}

const executors = {
  add_author,
  add_book,
  update_book,
  delete_book,
  delete_author,
  run_sql_select,
};

module.exports = { toolSchemas, executors };
