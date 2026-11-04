import { describe, expect, it } from 'vitest'

import { guardSql, type GuardFailureCode } from '../src/sql-guard.js'

/** ช่วยอ่านง่าย: คาดว่าต้องถูกปฏิเสธด้วยเหตุผลอะไร */
async function expectBlocked(sql: string, code: GuardFailureCode) {
  const result = await guardSql(sql)
  expect(result.ok, `ควรถูกปฏิเสธแต่กลับผ่าน: ${sql}`).toBe(false)
  if (!result.ok) expect(result.code, `เหตุผลไม่ตรง (ข้อความ: ${result.message})`).toBe(code)
  return result
}

async function expectAllowed(sql: string) {
  const result = await guardSql(sql)
  expect(
    result.ok,
    `ควรผ่านแต่ถูกปฏิเสธ: ${sql} — ${result.ok ? '' : result.message}`,
  ).toBe(true)
  return result
}

describe('คำสั่งที่ควรผ่าน', () => {
  it('SELECT ธรรมดา', async () => {
    const r = await expectAllowed('SELECT count(*) FROM deaths')
    if (r.ok) expect(r.relations).toEqual(['deaths'])
  })

  it('ระบุ schema app นำหน้าได้', async () => {
    await expectAllowed('SELECT count(*) FROM app.deaths')
  })

  it('WITH ... SELECT (CTE อ้างถึงชื่อตัวเองได้)', async () => {
    await expectAllowed(`
      WITH per_year AS (
        SELECT died_year, count(*) AS n FROM deaths WHERE is_complete_year GROUP BY died_year
      )
      SELECT died_year, n FROM per_year ORDER BY n DESC
    `)
  })

  it('CTE ซ้อน CTE', async () => {
    await expectAllowed(`
      WITH a AS (SELECT vehicle FROM deaths WHERE vehicle_known),
           b AS (SELECT vehicle, count(*) n FROM a GROUP BY vehicle)
      SELECT * FROM b
    `)
  })

  it('UNION ของสอง SELECT', async () => {
    await expectAllowed(
      "SELECT 'ชาย' AS k, count(*) FROM deaths WHERE sex = 'ชาย' " +
        "UNION ALL SELECT 'หญิง', count(*) FROM deaths WHERE sex = 'หญิง'",
    )
  })

  it('subquery และ window function', async () => {
    await expectAllowed(`
      SELECT vehicle, n, row_number() OVER (ORDER BY n DESC) AS rank
      FROM (SELECT vehicle, count(*) AS n FROM deaths GROUP BY vehicle) t
    `)
  })

  it('ไวยากรณ์ที่ parser แปลงเป็น pg_catalog.* เองอย่าง EXTRACT และ SUBSTRING', async () => {
    await expectAllowed(
      'SELECT extract(year from died_on), substring(sex from 1 for 2) FROM deaths',
    )
  })

  it('CAST, CASE, COALESCE ใช้ได้', async () => {
    await expectAllowed(
      'SELECT coalesce(age, 0), age::text, CASE WHEN age > 60 THEN 1 ELSE 0 END FROM deaths',
    )
  })

  it('อัฒภาคปิดท้ายคำสั่งเดียวไม่ถือว่าหลายคำสั่ง', async () => {
    await expectAllowed('SELECT count(*) FROM deaths;')
  })
})

describe('หลายคำสั่งในครั้งเดียว', () => {
  it('ปฏิเสธ SELECT ตามด้วย DROP', async () => {
    await expectBlocked('SELECT 1 FROM deaths; DROP TABLE app.deaths_raw;', 'MULTIPLE_STATEMENTS')
  })

  it('ปฏิเสธ SELECT ตามด้วย UPDATE', async () => {
    await expectBlocked('SELECT 1 FROM deaths; UPDATE deaths SET age = 0', 'MULTIPLE_STATEMENTS')
  })

  it('ปฏิเสธแม้คำสั่งที่สองจะเป็น SELECT ด้วยกัน', async () => {
    await expectBlocked('SELECT 1 FROM deaths; SELECT 2 FROM deaths', 'MULTIPLE_STATEMENTS')
  })

  it('อัฒภาคที่อยู่ใน string ไม่ใช่ตัวคั่นคำสั่ง จึงยังผ่าน', async () => {
    // regex ที่ตัดด้วยอัฒภาคจะพังตรงนี้ แต่ parser อ่านออกว่าเป็นข้อความ
    await expectAllowed("SELECT ';' AS semicolon_in_a_string FROM deaths")
  })
})

describe('คำสั่งเปลี่ยนแปลงข้อมูลและโครงสร้าง', () => {
  it.each([
    ['DROP TABLE app.deaths_raw', 'NOT_A_SELECT'],
    ['DELETE FROM deaths', 'NOT_A_SELECT'],
    ['UPDATE deaths SET age = 1', 'NOT_A_SELECT'],
    ["INSERT INTO app.deaths_raw (year_be) VALUES (2569)", 'NOT_A_SELECT'],
    ['TRUNCATE app.deaths_raw', 'NOT_A_SELECT'],
    ['CREATE TABLE evil (x int)', 'NOT_A_SELECT'],
    ['ALTER ROLE ai_reader SUPERUSER', 'NOT_A_SELECT'],
    ['GRANT SELECT ON app.deaths_raw TO ai_reader', 'NOT_A_SELECT'],
    ['COPY deaths TO STDOUT', 'NOT_A_SELECT'],
    ["SET statement_timeout = '1h'", 'NOT_A_SELECT'],
    ['BEGIN', 'NOT_A_SELECT'],
    ['EXPLAIN ANALYZE SELECT * FROM deaths', 'NOT_A_SELECT'],
  ] as const)('ปฏิเสธ %s', async (sql, code) => {
    await expectBlocked(sql, code)
  })

  it('ปฏิเสธ DELETE ที่ซ่อนใน CTE ของ SELECT', async () => {
    // เคสสำคัญที่สุดของไฟล์นี้: ชั้นบนสุดเป็น SELECT แต่ข้างในลบข้อมูลจริง
    // ถ้าเช็กแค่ว่า "ขึ้นต้นด้วย SELECT ไหม" จะปล่อยผ่าน
    await expectBlocked(
      'WITH d AS (DELETE FROM deaths RETURNING *) SELECT * FROM d',
      'FORBIDDEN_STATEMENT',
    )
  })

  it('ปฏิเสธ UPDATE ที่ซ่อนใน CTE', async () => {
    await expectBlocked(
      'WITH u AS (UPDATE deaths SET age = 1 RETURNING id) SELECT count(*) FROM u',
      'FORBIDDEN_STATEMENT',
    )
  })

  it('ปฏิเสธ INSERT ที่ซ่อนใน CTE', async () => {
    await expectBlocked(
      'WITH i AS (INSERT INTO app.deaths_raw (year_be, died_on) ' +
        "VALUES (2569, '2026-01-01') RETURNING id) SELECT * FROM i",
      'FORBIDDEN_STATEMENT',
    )
  })

  it('ปฏิเสธ SELECT ... INTO ที่สร้างตารางใหม่', async () => {
    await expectBlocked('SELECT * INTO evil FROM deaths', 'SELECT_INTO')
  })

  it('ปฏิเสธ FOR UPDATE ที่ล็อกแถว', async () => {
    await expectBlocked('SELECT * FROM deaths FOR UPDATE', 'FORBIDDEN_CONSTRUCT')
  })
})

describe('การอ้างถึงตารางอื่น', () => {
  it.each([
    'SELECT * FROM app.deaths_raw',
    'SELECT * FROM deaths_raw',
    'SELECT * FROM pg_catalog.pg_tables',
    'SELECT * FROM pg_tables',
    'SELECT * FROM information_schema.columns',
    'SELECT * FROM pg_stat_activity',
    'SELECT * FROM pg_shadow',
    'SELECT * FROM public.anything',
  ])('ปฏิเสธ %s', async (sql) => {
    await expectBlocked(sql, 'FORBIDDEN_RELATION')
  })

  it('ปฏิเสธตารางต้องห้ามที่ซ่อนใน JOIN', async () => {
    await expectBlocked(
      'SELECT d.id FROM deaths d JOIN pg_catalog.pg_roles r ON true',
      'FORBIDDEN_RELATION',
    )
  })

  it('ปฏิเสธตารางต้องห้ามที่ซ่อนใน subquery', async () => {
    await expectBlocked(
      'SELECT (SELECT count(*) FROM pg_catalog.pg_tables) AS leak FROM deaths',
      'FORBIDDEN_RELATION',
    )
  })

  it('ปฏิเสธตารางต้องห้ามที่ซ่อนใน CTE', async () => {
    await expectBlocked(
      'WITH leak AS (SELECT rolname FROM pg_roles) SELECT * FROM leak',
      'FORBIDDEN_RELATION',
    )
  })

  it('ปฏิเสธ UNION กับตารางระบบ', async () => {
    await expectBlocked(
      'SELECT id::text FROM deaths UNION ALL SELECT rolname FROM pg_roles',
      'FORBIDDEN_RELATION',
    )
  })

  it('ชื่อ CTE ที่ชนกับตารางต้องห้ามใช้ได้ เพราะเป็นคนละสิ่ง', async () => {
    await expectAllowed('WITH pg_tables AS (SELECT 1 AS x) SELECT * FROM pg_tables')
  })
})

describe('ฟังก์ชันอันตราย', () => {
  it.each([
    'SELECT pg_sleep(10)',
    'SELECT pg_catalog.pg_sleep(10)',
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT pg_read_binary_file('/etc/passwd')",
    "SELECT pg_ls_dir('/')",
    'SELECT pg_terminate_backend(1)',
    "SELECT set_config('statement_timeout', '1h', false)",
    "SELECT dblink('host=evil', 'SELECT 1')",
    'SELECT generate_series(1, 1000000000)',
    "SELECT lo_import('/etc/passwd')",
    'SELECT current_setting(\'is_superuser\')',
    'SELECT version()',
    'SELECT pg_read_file(f) FROM deaths, lateral (SELECT \'/etc/passwd\' AS f) x',
  ])('ปฏิเสธ %s', async (sql) => {
    await expectBlocked(sql, 'FORBIDDEN_FUNCTION')
  })

  it('ปฏิเสธฟังก์ชันที่ซ่อนใน WHERE', async () => {
    await expectBlocked('SELECT id FROM deaths WHERE pg_sleep(5) IS NULL', 'FORBIDDEN_FUNCTION')
  })

  it('ปฏิเสธฟังก์ชันที่ซ่อนใน ORDER BY', async () => {
    await expectBlocked('SELECT id FROM deaths ORDER BY pg_sleep(5)', 'FORBIDDEN_FUNCTION')
  })

  it('ปฏิเสธฟังก์ชันที่เรียกข้าม schema ที่ไม่ใช่ pg_catalog', async () => {
    await expectBlocked('SELECT evil.count(*) FROM deaths', 'FORBIDDEN_FUNCTION')
  })
})

describe('คอมเมนต์ที่พยายามซ่อนคำสั่ง', () => {
  it('คอมเมนต์บรรทัดเดียวที่มีคำสั่งอันตรายอยู่ข้างใน ถูกมองข้ามโดย parser', async () => {
    const r = await expectAllowed('SELECT count(*) FROM deaths -- ; DROP TABLE app.deaths_raw')
    // ยืนยันว่า SQL ที่จะเอาไปรันยังเป็นคำสั่งเดิม ไม่ได้ถูกตัดต่อ
    if (r.ok) expect(r.sql).toContain('deaths')
  })

  it('คอมเมนต์แบบบล็อกที่มีอัฒภาคข้างใน', async () => {
    await expectAllowed('SELECT count(*) /* ; DROP TABLE app.deaths_raw ; */ FROM deaths')
  })

  it('คำสั่งจริงที่ตามหลังคอมเมนต์ยังถูกจับได้', async () => {
    // คอมเมนต์ไม่ได้ช่วยซ่อน คำสั่งที่สองยังเป็นคำสั่งที่สองอยู่ดี
    await expectBlocked(
      'SELECT 1 FROM deaths -- ดูเหมือนจบแล้ว\n; DROP TABLE app.deaths_raw',
      'MULTIPLE_STATEMENTS',
    )
  })

  it('คอมเมนต์เปิดค้างทำให้ไวยากรณ์พัง จึงถูกปฏิเสธ', async () => {
    await expectBlocked('SELECT count(*) FROM deaths /* ไม่ได้ปิด', 'PARSE_ERROR')
  })
})

describe('การบังคับ LIMIT', () => {
  it('เติม LIMIT ให้เมื่อไม่มี', async () => {
    const r = await guardSql('SELECT * FROM deaths', { maxRows: 100 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.limit).toBe('added')
      expect(r.sql).toContain('LIMIT 100')
      expect(r.sql).toContain('guarded_result')
    }
  })

  it('ไม่ยุ่งกับ LIMIT ที่เล็กกว่าเพดานอยู่แล้ว', async () => {
    const r = await guardSql('SELECT * FROM deaths LIMIT 5', { maxRows: 100 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.limit).toBe('already-present')
      expect(r.sql).toBe('SELECT * FROM deaths LIMIT 5')
    }
  })

  it('กด LIMIT ที่ใหญ่เกินเพดานลงมา', async () => {
    const r = await guardSql('SELECT * FROM deaths LIMIT 999999', { maxRows: 100 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.limit).toBe('capped')
      expect(r.sql).toContain('LIMIT 100')
    }
  })

  it('ครอบ LIMIT ให้ UNION ได้ถูกต้อง (ต่อข้อความท้ายคำสั่งจะได้ผลผิด)', async () => {
    const r = await guardSql('SELECT 1 FROM deaths UNION ALL SELECT 2 FROM deaths', {
      maxRows: 10,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.sql).toMatch(/\)\s*AS guarded_result LIMIT 10$/)
  })

  it('SQL ที่ครอบแล้วยังต้องผ่านการตรวจซ้ำทั้งชุด', async () => {
    const r = await guardSql('SELECT * FROM deaths', { maxRows: 10 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const again = await guardSql(r.sql, { maxRows: 10 })
      expect(again.ok).toBe(true)
    }
  })
})

describe('อินพุตที่ไม่ใช่ SQL', () => {
  it.each(['', '   ', '\n\t '])('ปฏิเสธข้อความว่าง', async (sql) => {
    await expectBlocked(sql, 'EMPTY')
  })

  it('ปฏิเสธข้อความที่ไม่ใช่ SQL', async () => {
    await expectBlocked('ขอจำนวนผู้เสียชีวิตหน่อย', 'PARSE_ERROR')
  })

  it('ปฏิเสธ SQL ที่ไวยากรณ์ผิด', async () => {
    await expectBlocked('SELECT FROM WHERE', 'PARSE_ERROR')
  })

  it('ปฏิเสธคอมเมนต์ล้วนที่ไม่มีคำสั่ง', async () => {
    await expectBlocked('-- ไม่มีอะไรเลย', 'EMPTY')
  })
})
