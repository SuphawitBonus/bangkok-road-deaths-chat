// แยกชนิดของความล้มเหลวใน ask() และข้อความที่แสดงผู้ใช้
//
// ──────────────────────────────────────────────────────────────────────────
// ทำไมต้องแยกชนิด แทนที่จะคืน "เกิดข้อผิดพลาด" อย่างเดียว
// ──────────────────────────────────────────────────────────────────────────
// คนที่ต้องทำอะไรต่อไม่ใช่คนเดียวกัน และสิ่งที่ต้องทำก็ต่างกัน
//
//   ชนิด               ใครต้องแก้     ลองใหม่ช่วยไหม   ตัวอย่าง
//   out_of_credit      เจ้าของระบบ    ไม่               เครดิต API หมด
//   auth               เจ้าของระบบ    ไม่               key ผิด / ถูกยกเลิก
//   rate_limited       ไม่มีใคร       ช่วย (รอสักพัก)   ยิงถี่เกิน
//   overloaded         ไม่มีใคร       ช่วย (รอสักพัก)   API ล่มหรือโหลดสูง
//   network            ไม่มีใคร       ช่วย              เน็ตหลุด หมดเวลา
//   bad_request        นักพัฒนา       ไม่               โค้ดเราส่ง request ผิดรูป
//   model_*            นักพัฒนา       อาจช่วย          โมเดลตอบไม่จบในจำนวนรอบ ฯลฯ
//   final_sql_failed   นักพัฒนา       อาจช่วย          SQL สุดท้ายรันไม่ผ่าน
//
// SDK ลองใหม่ให้เองแล้ว (maxRetries) สำหรับ 429 / 5xx / เน็ตหลุด ถ้ายังมาถึงตรงนี้แปลว่าลองครบแล้ว
//
// ──────────────────────────────────────────────────────────────────────────
// หลักของข้อความที่ผู้ใช้เห็น
// ──────────────────────────────────────────────────────────────────────────
// 1. ไม่บอกรายละเอียดภายใน — ผู้ใช้หน้าเว็บไม่ต้องรู้ว่าเครดิตของเราหมด หรือ key ของเราผิด
//    รายละเอียดจริงอยู่ใน `detail` สำหรับ log ฝั่งเซิร์ฟเวอร์เท่านั้น
// 2. บอกว่าควรทำอะไรต่อ — ลองใหม่อีกสักครู่ได้ หรือลองใหม่ไปก็ไม่ช่วย
// 3. ไม่มีตัวเลขเลย และไม่ใช่ "การปฏิเสธ" (refused = false) — ระบบไม่ได้ตัดสินว่าข้อมูลตอบไม่ได้
//    แค่ตอบไม่สำเร็จ ถ้าปนกัน หน้าเว็บจะบอกผู้ใช้ผิดว่า "ข้อมูลไม่มี" ทั้งที่จริงมี
// 4. ภาษาเดียวกับคำถาม เหมือนคำตอบปกติ
import Anthropic from '@anthropic-ai/sdk'

export type AskErrorCode =
  | 'out_of_credit'
  | 'auth'
  | 'rate_limited'
  | 'overloaded'
  | 'network'
  | 'bad_request'
  | 'model_safety_refusal'
  | 'model_max_tokens'
  | 'model_invalid_output'
  | 'model_round_limit'
  | 'final_sql_failed'

export interface AskError {
  code: AskErrorCode
  /** ลองใหม่ภายหลังมีโอกาสสำเร็จหรือไม่ — หน้าเว็บใช้ตัดสินว่าจะแสดงปุ่ม "ลองอีกครั้ง" */
  retryable: boolean
  /**
   * ความล้มเหลวนี้ทำให้ "ทุกคำถาม" ล้มเหมือนกันจนกว่าเจ้าของระบบจะแก้ (เครดิตหมด, key ผิด)
   * ตัวรัน eval ใช้ธงนี้หยุดทั้งชุดทันที แทนที่จะยิงต่อจนครบแล้วได้ error ทุกข้อ
   */
  fatal: boolean
  /** ข้อความภายในสำหรับ log — ห้ามแสดงผู้ใช้ */
  detail: string
}

const RULES: Record<AskErrorCode, { retryable: boolean; fatal: boolean }> = {
  out_of_credit: { retryable: false, fatal: true },
  auth: { retryable: false, fatal: true },
  rate_limited: { retryable: true, fatal: false },
  overloaded: { retryable: true, fatal: false },
  network: { retryable: true, fatal: false },
  bad_request: { retryable: false, fatal: false },
  model_safety_refusal: { retryable: false, fatal: false },
  model_max_tokens: { retryable: true, fatal: false },
  model_invalid_output: { retryable: true, fatal: false },
  model_round_limit: { retryable: true, fatal: false },
  final_sql_failed: { retryable: true, fatal: false },
}

export function askError(code: AskErrorCode, detail: string): AskError {
  return { code, ...RULES[code], detail }
}

/**
 * แปลง error จาก SDK เป็นชนิดของเรา
 *
 * ลำดับการตรวจ: ใช้คลาสของ SDK และ `.type` ของ API ก่อนเสมอ เพราะเป็นสัญญาที่ API ให้ไว้
 *
 * ข้อยกเว้นเดียวที่ต้องดูข้อความ: เครดิตหมด เอกสารของ API บอกว่าปัญหาการเงินคืน
 * 402 `billing_error` แต่ที่เจอจริงกับบัญชีนี้ (5 พ.ย. 2569) คือ
 *   400 invalid_request_error "Your credit balance is too low to access the Anthropic API..."
 * ซึ่งชนิดซ้ำกับ request ผิดรูปทั่วไป จึงไม่มีสัญญาณอื่นให้แยก การตรวจข้อความนี้จึงจำกัดไว้
 * เฉพาะ 400 + คำว่า "credit balance" เท่านั้น ถ้า API เปลี่ยนข้อความ จะตกไปเป็น bad_request
 * ซึ่งยังไม่ลองใหม่และยังบอกผู้ใช้ถูกว่าลองใหม่ไม่ช่วย — ผิดพลาดไปทางปลอดภัย
 */
export function classifyApiError(err: unknown): AskError {
  const message = err instanceof Error ? err.message : String(err)

  // APIConnectionError เป็นคลาสลูกของ APIError ใน TypeScript SDK จึงต้องตรวจก่อน
  if (err instanceof Anthropic.APIConnectionError) return askError('network', message)
  if (!(err instanceof Anthropic.APIError)) return askError('network', message)

  const detail = `${err.status ?? ''} ${err.type ?? ''}: ${message}`.trim()

  if (err.type === 'billing_error' || err.status === 402) return askError('out_of_credit', detail)
  if (err instanceof Anthropic.BadRequestError && /credit balance/i.test(message)) {
    return askError('out_of_credit', detail)
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return askError('auth', detail)
  }
  if (err instanceof Anthropic.RateLimitError) return askError('rate_limited', detail)
  if (err.type === 'overloaded_error' || err.status === 529 || (err.status ?? 0) >= 500) {
    return askError('overloaded', detail)
  }
  return askError('bad_request', detail)
}

/** คำถามเป็นภาษาไทยไหม — ใช้เลือกภาษาของข้อความ error (มีอักษรไทยตัวเดียวก็ถือว่าไทย) */
export const isThai = (text: string) => /[฀-๿]/.test(text)

/** ข้อความที่ผู้ใช้เห็นเมื่อตอบไม่สำเร็จ */
export function userMessage(e: AskError, question: string): string {
  const th = isThai(question)
  switch (e.code) {
    case 'out_of_credit':
    case 'auth':
      // ไม่บอกว่าเครดิตหมดหรือ key ผิด — เป็นเรื่องภายในของเจ้าของระบบ ผู้ใช้ทำอะไรไม่ได้
      return th
        ? 'ขออภัย ตอนนี้ระบบถามตอบปิดให้บริการชั่วคราว ลองใหม่อีกครั้งก็จะยังไม่สำเร็จจนกว่าผู้ดูแลจะแก้ไข'
        : 'Sorry, the question service is temporarily unavailable. Retrying will not help until the maintainer fixes it.'
    case 'rate_limited':
    case 'overloaded':
    case 'network':
      return th
        ? 'ขออภัย ตอนนี้มีผู้ใช้งานมากหรือระบบ AI ไม่ตอบสนอง กรุณาลองใหม่อีกครั้งในอีกสักครู่'
        : 'Sorry, the AI service is busy or not responding right now. Please try again in a moment.'
    case 'model_round_limit':
    case 'model_max_tokens':
    case 'model_invalid_output':
    case 'final_sql_failed':
      return th
        ? 'ขออภัย ระบบหาคำตอบสำหรับคำถามนี้ไม่สำเร็จ ลองถามใหม่อีกครั้ง หรือเปลี่ยนวิธีถามให้เจาะจงขึ้น'
        : 'Sorry, the system could not work out an answer to this question. Try again, or rephrase it more specifically.'
    case 'model_safety_refusal':
      return th
        ? 'ขออภัย ระบบไม่สามารถตอบคำถามนี้ได้ ลองเปลี่ยนวิธีถาม'
        : 'Sorry, the system cannot answer this question. Try rephrasing it.'
    case 'bad_request':
      return th
        ? 'ขออภัย เกิดข้อผิดพลาดภายในระบบ ลองใหม่อีกครั้งก็จะยังไม่สำเร็จ'
        : 'Sorry, something went wrong on our side. Retrying will not help.'
  }
}
