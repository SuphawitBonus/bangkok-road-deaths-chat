// system prompt ของ ask() — แยกไฟล์ไว้เพราะเป็นสิ่งที่ถูกแก้บ่อยที่สุดตอนปรับด้วยชุด dev
//
// หลักที่ยึด
//   1. คำอธิบาย schema ไม่ได้เขียนมือในไฟล์นี้ แต่ดึงจาก COMMENT ON ในฐานข้อมูล (schema-doc.ts)
//      เพื่อไม่ให้ prompt หลุดจากความจริงของ view
//   2. ข้อความทั้งหมดต้อง "นิ่ง" ทุก byte — ห้ามใส่วันเวลา ห้ามใส่คำถาม ห้ามสุ่มลำดับ
//      เพราะ prompt caching จับคู่แบบ prefix ถ้าเปลี่ยนแม้ตัวเดียว cache ทั้งก้อนจะหลุด
//   3. ตัวอย่าง (few-shot) ถ้ามี ต้องแต่งใหม่ทั้งหมด ห้ามหยิบหรือดัดแปลงจาก evals/questions.jsonl
//      ไม่งั้นคะแนนจะวัดว่าโมเดลจำเฉลยได้ ไม่ใช่ว่าเขียน SQL เป็น
//
// ทุกครั้งที่แก้ prompt ให้ขยับ PROMPT_VERSION และจดใน docs/evals-log.md
// ผลการรัน eval บันทึกเวอร์ชันนี้ไว้ จึงย้อนดูได้ว่าคะแนนไหนมาจาก prompt ไหน
import { createHash } from 'node:crypto'

import { describeRelation, toPromptText } from './schema-doc.js'

export const PROMPT_VERSION = 'v1-baseline'

export interface PromptConfig {
  maxToolRounds: number
}

export function buildSystemPrompt(schemaText: string, cfg: PromptConfig): string {
  return `You answer questions about road-traffic deaths in Bangkok by querying a PostgreSQL database.

# Database

There is exactly one view you can query, \`deaths\`. Its documentation (written in Thai, from the database's own COMMENT ON) is below. Read the warnings in it: they describe real traps in this data.

${schemaText}

# How to work

- Use the run_sql tool to run one read-only SELECT against \`deaths\`. You can call it at most ${cfg.maxToolRounds} times per question. If a query is rejected or fails, the error comes back to you so you can fix the query.
- Every number in your answer must come from a query result or from the documentation above. Never use outside knowledge for numbers.
- If the data cannot answer the question (the needed column does not exist, the question asks for a forecast, or it needs outside data), refuse: say what is missing instead of guessing.

# Final answer

When you are done, reply with JSON only, matching the response schema:
- answer: the answer for the user, in the same language as the question.
- final_sql: the one query whose result answers the question, exactly as you ran it. null if you refused.
- caveats: data caveats the user should know for this answer (may be empty).
- refused: true if the data cannot answer the question.
- refusal_reason: why, when refused is true; otherwise null.`
}

let cached: Promise<string> | undefined

/** คำอธิบาย schema จากฐานข้อมูล อ่านครั้งเดียวต่อ process เพราะไม่เปลี่ยนระหว่างรัน */
export function schemaPromptText(): Promise<string> {
  cached ??= describeRelation().then(toPromptText)
  return cached
}

/** hash สั้น ๆ ของ prompt ที่ส่งจริง ใช้ยืนยันว่าสองรอบที่เทียบกันใช้ prompt เดียวกันจริง */
export function promptHash(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 12)
}
