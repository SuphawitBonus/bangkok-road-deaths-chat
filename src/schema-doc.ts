// ดึงคำอธิบาย schema ออกจากฐานข้อมูลจริง
//
// สัปดาห์ที่ 2 จะเรียกฟังก์ชันนี้เพื่อประกอบ prompt ให้ AI แทนที่จะเขียนคำอธิบาย
// schema ไว้ใน prompt ตรง ๆ เหตุผลคือคำอธิบายที่เขียนมือจะค่อย ๆ หลุดจากความจริง
// เมื่อ schema เปลี่ยน แต่ COMMENT ON อยู่ติดกับคอลัมน์ ถ้าแก้ view ก็เห็นเลยว่า
// ต้องแก้คำอธิบายด้วย
//
// ตอนนี้ใช้สร้าง docs/data-dictionary.md เพื่อให้คนอ่านได้ด้วย
import { adminPool } from './lib/db.js'

export interface ColumnDoc {
  name: string
  type: string
  nullable: boolean
  comment: string | null
}

export interface RelationDoc {
  schema: string
  name: string
  comment: string | null
  columns: ColumnDoc[]
}

export async function describeRelation(
  schema = 'app',
  relation = 'deaths',
): Promise<RelationDoc> {
  const pool = adminPool()

  const header = await pool.query<{ comment: string | null }>(
    `SELECT obj_description(format('%I.%I', $1::text, $2::text)::regclass, 'pg_class') AS comment`,
    [schema, relation],
  )

  const columns = await pool.query<ColumnDoc>(
    `SELECT a.attname                                   AS name,
            format_type(a.atttypid, a.atttypmod)        AS type,
            NOT a.attnotnull                            AS nullable,
            col_description(a.attrelid, a.attnum)       AS comment
       FROM pg_attribute a
      WHERE a.attrelid = format('%I.%I', $1::text, $2::text)::regclass
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [schema, relation],
  )

  return {
    schema,
    name: relation,
    comment: header.rows[0]?.comment ?? null,
    columns: columns.rows,
  }
}

/** รูปแบบข้อความที่จะส่งให้ AI ในสัปดาห์ที่ 2 — กระชับ อ่านด้วยโมเดลได้ */
export function toPromptText(doc: RelationDoc): string {
  const lines = [
    `ตาราง/วิว: ${doc.name}`,
    doc.comment ? `คำอธิบาย: ${doc.comment}` : '',
    '',
    'คอลัมน์:',
    ...doc.columns.map(
      (c) => `- ${c.name} (${c.type})${c.comment ? `: ${c.comment}` : ''}`,
    ),
  ]
  return lines.filter((l) => l !== '').join('\n')
}

/** รูปแบบ Markdown สำหรับให้คนอ่าน */
export function toMarkdown(doc: RelationDoc): string {
  const out: string[] = [
    '# พจนานุกรมข้อมูล',
    '',
    '> ไฟล์นี้สร้างอัตโนมัติด้วย `npx tsx src/scripts/dump-schema-doc.ts`',
    '> เนื้อหามาจาก `COMMENT ON` ในฐานข้อมูลจริง ไม่ได้เขียนมือ',
    '> ถ้าจะแก้คำอธิบาย ให้แก้ที่ `db/02_view.sql` แล้ว migrate ใหม่',
    '',
    `## \`${doc.schema}.${doc.name}\``,
    '',
  ]
  if (doc.comment) out.push(doc.comment, '')

  out.push('| คอลัมน์ | ชนิด | ว่างได้ | ความหมายและข้อควรระวัง |', '| --- | --- | :-: | --- |')
  for (const c of doc.columns) {
    const comment = (c.comment ?? '—').replace(/\|/g, '\\|')
    out.push(`| \`${c.name}\` | \`${c.type}\` | ${c.nullable ? '✓' : ''} | ${comment} |`)
  }
  out.push('')
  return out.join('\n')
}
