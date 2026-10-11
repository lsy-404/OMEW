import { ref } from 'vue'

const openPostSeq = ref<number | null>(null)
const targetReplySeq = ref<number | null>(null)

function open(postSeq: number, replySeq: number = postSeq) {
  openPostSeq.value = postSeq
  targetReplySeq.value = replySeq === postSeq ? null : replySeq
}

function close() {
  openPostSeq.value = null
  targetReplySeq.value = null
}

export function usePostModal() {
  return { openPostSeq, targetReplySeq, open, close }
}
