import { Timestamp, type Transaction } from 'firebase-admin/firestore'
import { MessageRequestSchema, MessageSchema, queuedMessage, messageForWrite, type MessageRequest } from '@llenamos/core'
import { db, stamp } from '../shared'

/** Escribe el aviso junto con la operación que lo origina; R2 se encarga del envío. */
export function enqueueMessage(tx: Transaction, rid: string, request: MessageRequest, key?: string): string {
  const message = MessageSchema.parse(queuedMessage(MessageRequestSchema.parse(request)))
  const collection = db.collection(`restaurants/${rid}/messages`)
  const ref = key ? collection.doc(key) : collection.doc()
  tx.create(ref, { ...messageForWrite(message, Timestamp.fromMillis), ...stamp() })
  return ref.id
}
