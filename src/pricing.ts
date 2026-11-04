// ราคาต่อ 1 ล้าน token (USD) ของ Claude API ณ ตุลาคม 2026 — ใช้คำนวณค่าใช้จ่าย "โดยประมาณ" ใน eval
//
// ทำไมต้องคำนวณเอง: API คืน usage เป็นจำนวน token ไม่ได้คืนเป็นเงิน และ token แต่ละชนิด
// ราคาไม่เท่ากัน (อ่านจาก cache ถูกกว่าเขียนลง cache 12.5 เท่า) ถ้าดูแค่ token รวมจะเทียบ
// สอง model หรือสองเวอร์ชันของ prompt ไม่ได้
//
// ตัวคูณของ cache ใช้แบบเดียวกันทุก model: อ่าน 0.1 เท่าของราคา input, เขียน (TTL 5 นาที) 1.25 เท่า
// Haiku 5.5 มีราคาสองขั้น แบ่งที่ prompt 100K token — ระบบนี้ใช้ไม่ถึง 10K จึงใช้ขั้นแรกเสมอ
// ถ้าราคาเปลี่ยน แก้ที่ไฟล์นี้ที่เดียว ผลที่บันทึกไว้แล้วเก็บจำนวน token ดิบไว้ คำนวณใหม่ได้

export interface ModelPrice {
  input: number
  output: number
}

export const PRICES: Record<string, ModelPrice> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
}

export const CACHE_READ_MULTIPLIER = 0.1
export const CACHE_WRITE_MULTIPLIER = 1.25

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  /** ส่วนหนึ่งของ output_tokens ที่เป็นการคิดภายใน (คิดเงินเท่า output ปกติ) */
  thinking_tokens: number
}

export const emptyUsage = (): TokenUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  thinking_tokens: 0,
})

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    thinking_tokens: a.thinking_tokens + b.thinking_tokens,
  }
}

/** ค่าใช้จ่ายโดยประมาณเป็น USD คืน null ถ้าไม่รู้ราคาของ model นี้ (ดีกว่าเดาเป็นศูนย์) */
export function estimateCostUsd(model: string, u: TokenUsage): number | null {
  const p = PRICES[model]
  if (!p) return null
  const perToken = (perMillion: number) => perMillion / 1_000_000
  return (
    u.input_tokens * perToken(p.input) +
    u.cache_creation_input_tokens * perToken(p.input * CACHE_WRITE_MULTIPLIER) +
    u.cache_read_input_tokens * perToken(p.input * CACHE_READ_MULTIPLIER) +
    u.output_tokens * perToken(p.output)
  )
}
