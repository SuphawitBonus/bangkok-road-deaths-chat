// ทดสอบการแยกชนิดความล้มเหลวของ ask() — ไม่เรียก API จริง
// error ถูกสร้างด้วย APIError.generate() ซึ่งเป็นฟังก์ชันเดียวกับที่ SDK ใช้สร้าง error จาก response จริง
import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'

import { askError, classifyApiError, userMessage, type AskErrorCode } from '../src/ask-errors.js'

const apiError = (status: number, type: string, message: string) =>
  Anthropic.APIError.generate(status, { type: 'error', error: { type, message } }, message, new Headers())

// ข้อความจริงที่ API ตอบกลับมาตอนรัน eval ครั้งแรก (5 พ.ย. 2569)
const REAL_LOW_CREDIT = apiError(
  400,
  'invalid_request_error',
  'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
)

describe('classifyApiError', () => {
  it('เครดิตหมดแบบที่เจอจริง (400 invalid_request_error) → out_of_credit', () => {
    const e = classifyApiError(REAL_LOW_CREDIT)
    expect(e.code).toBe('out_of_credit')
    expect(e.retryable).toBe(false)
    expect(e.fatal).toBe(true)
  })

  it('เครดิตหมดแบบที่เอกสารระบุ (402 billing_error) → out_of_credit', () => {
    expect(classifyApiError(apiError(402, 'billing_error', 'Payment required')).code).toBe('out_of_credit')
  })

  it('400 อื่นที่ไม่เกี่ยวกับเครดิต → bad_request ไม่ใช่ out_of_credit', () => {
    const e = classifyApiError(apiError(400, 'invalid_request_error', 'max_tokens: must be positive'))
    expect(e.code).toBe('bad_request')
    expect(e.fatal).toBe(false)
  })

  it.each<[number, string, AskErrorCode, boolean]>([
    [401, 'authentication_error', 'auth', false],
    [403, 'permission_error', 'auth', false],
    [429, 'rate_limit_error', 'rate_limited', true],
    [529, 'overloaded_error', 'overloaded', true],
    [500, 'api_error', 'overloaded', true],
  ])('%i %s → %s (ลองใหม่ได้: %s)', (status, type, code, retryable) => {
    const e = classifyApiError(apiError(status, type, 'x'))
    expect(e.code).toBe(code)
    expect(e.retryable).toBe(retryable)
  })

  it('เชื่อมต่อไม่ได้ / หมดเวลา → network ลองใหม่ได้', () => {
    expect(classifyApiError(new Anthropic.APIConnectionError({ message: 'ECONNRESET' })).code).toBe('network')
    expect(classifyApiError(new Anthropic.APIConnectionTimeoutError()).retryable).toBe(true)
  })

  it('detail เก็บข้อความจริงไว้ให้ log', () => {
    expect(classifyApiError(REAL_LOW_CREDIT).detail).toContain('credit balance is too low')
  })
})

describe('userMessage', () => {
  const credit = classifyApiError(REAL_LOW_CREDIT)

  it('ตอบภาษาเดียวกับคำถาม', () => {
    expect(userMessage(credit, 'ปี 2567 มีผู้เสียชีวิตกี่ราย')).toMatch(/ขออภัย/)
    expect(userMessage(credit, 'How many deaths in 2024?')).toMatch(/^Sorry/)
  })

  it('ไม่บอกผู้ใช้ว่าเครดิตหมดหรือ key ผิด (เป็นเรื่องภายใน)', () => {
    for (const q of ['คำถาม', 'question']) {
      const m = userMessage(credit, q).toLowerCase()
      expect(m).not.toMatch(/credit|เครดิต|billing|key|anthropic/)
    }
  })

  it('บอกว่าลองใหม่ช่วยหรือไม่ ให้ตรงกับ retryable', () => {
    expect(userMessage(credit, 'q')).toMatch(/will not help/)
    expect(userMessage(askError('overloaded', 'x'), 'q')).toMatch(/try again/i)
  })

  it('ทุกข้อความไม่มีตัวเลข — ข้อความ error ต้องไม่ดูเหมือนคำตอบ', () => {
    const codes: AskErrorCode[] = [
      'out_of_credit', 'auth', 'rate_limited', 'overloaded', 'network', 'bad_request',
      'model_safety_refusal', 'model_max_tokens', 'model_invalid_output', 'model_round_limit', 'final_sql_failed',
    ]
    for (const c of codes) {
      expect(userMessage(askError(c, 'x'), 'คำถาม')).not.toMatch(/\d/)
      expect(userMessage(askError(c, 'x'), 'question')).not.toMatch(/\d/)
    }
  })
})
