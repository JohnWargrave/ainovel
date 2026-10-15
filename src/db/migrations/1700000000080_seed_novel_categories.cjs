// The genre list the catalog launches with: the usual Vietnamese web-novel genres, in the order the
// app's genre picker shows them. Editors rename, reorder or hide them in the CMS afterwards, so the
// insert skips any slug that already exists instead of overwriting an editor's change.

exports.shorthands = undefined;

const CATEGORIES = [
  ['tien-hiep', 'Tiên Hiệp'],
  ['huyen-huyen', 'Huyền Huyễn'],
  ['kiem-hiep', 'Kiếm Hiệp'],
  ['do-thi', 'Đô Thị'],
  ['ngon-tinh', 'Ngôn Tình'],
  ['xuyen-khong', 'Xuyên Không'],
  ['trong-sinh', 'Trọng Sinh'],
  ['he-thong', 'Hệ Thống'],
  ['khoa-huyen', 'Khoa Huyễn'],
  ['vong-du', 'Võng Du'],
  ['mat-the', 'Mạt Thế'],
  ['di-nang', 'Dị Năng'],
  ['lich-su', 'Lịch Sử'],
  ['quan-su', 'Quân Sự'],
  ['quan-truong', 'Quan Trường'],
  ['cung-dau', 'Cung Đấu'],
  ['dien-van', 'Điền Văn'],
  ['nu-cuong', 'Nữ Cường'],
  ['dam-my', 'Đam Mỹ'],
  ['bach-hop', 'Bách Hợp'],
  ['hoc-duong', 'Học Đường'],
  ['hai-huoc', 'Hài Hước'],
  ['linh-di', 'Linh Dị'],
  ['kinh-di', 'Kinh Dị'],
  ['trinh-tham', 'Trinh Thám'],
  ['dong-nhan', 'Đồng Nhân'],
];

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  const rows = CATEGORIES.map(
    ([slug, name], index) => `(gen_random_uuid(), '${slug}', '${name}', ${(index + 1) * 10})`,
  ).join(',\n      ');
  pgm.sql(`
    INSERT INTO novel_categories (id, slug, name, sort_order)
    VALUES
      ${rows}
    ON CONFLICT (slug) DO NOTHING;
  `);
};

// Only removes seeded categories no novel uses, so a rollback never strips genres off the catalog.
exports.down = (pgm) => {
  const slugs = CATEGORIES.map(([slug]) => `'${slug}'`).join(', ');
  pgm.sql(`
    DELETE FROM novel_categories c
    WHERE c.slug IN (${slugs})
      AND NOT EXISTS (SELECT 1 FROM novel_category_links l WHERE l.category_id = c.id);
  `);
};
