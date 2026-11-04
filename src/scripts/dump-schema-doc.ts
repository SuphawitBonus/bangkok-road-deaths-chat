// สร้าง docs/data-dictionary.md จาก COMMENT ON ในฐานข้อมูล
import { writeFile } from 'node:fs/promises'

import { closePools } from '../lib/db.js'
import { describeRelation, toMarkdown, toPromptText } from '../schema-doc.js'

async function main(): Promise<void> {
  const doc = await describeRelation('app', 'deaths')

  const missing = doc.columns.filter((c) => !c.comment).map((c) => c.name)
  if (missing.length > 0) {
    console.log(`เตือน: ยังไม่มีคำอธิบายของคอลัมน์ ${missing.join(', ')}`)
    process.exitCode = 1
  }

  await writeFile('docs/data-dictionary.md', toMarkdown(doc), 'utf8')
  console.log(`เขียน docs/data-dictionary.md แล้ว (${doc.columns.length} คอลัมน์)`)
  console.log(
    `ขนาดข้อความที่จะส่งให้ AI ในสัปดาห์ที่ 2: ${toPromptText(doc).length.toLocaleString('th-TH')} ตัวอักษร`,
  )
  await closePools()
}

main().catch((err: unknown) => {
  console.error('สร้างเอกสารไม่สำเร็จ:', err instanceof Error ? err.message : err)
  process.exitCode = 1
  void closePools()
})
