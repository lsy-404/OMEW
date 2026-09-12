import { describe, expect, it } from 'vitest'

import app from '../web/src/App.vue?raw'
import chatPane from '../web/src/components/ChatPane.vue?raw'
import directoryModal from '../web/src/components/DirectoryModal.vue?raw'
import leftColumn from '../web/src/components/LeftColumn.vue?raw'
import postModal from '../web/src/components/PostModal.vue?raw'
import rightColumn from '../web/src/components/RightColumn.vue?raw'
import onboarding from '../web/src/components/StrongholdOnboarding.vue?raw'
import chatRoom from '../web/src/composables/useChatRoom.ts?raw'
import sectionRoom from '../web/src/composables/useSectionRoom.ts?raw'
import strongholdState from '../web/src/composables/useStronghold.ts?raw'

describe('首次登录据点选择', () => {
  it('在已登录但尚未加入据点时保留首次引导', () => {
    expect(app).toContain('<StrongholdOnboarding v-else-if="auth.isAuthenticated.value && !hasStrongholds" />')
  })

  it('首次引导允许先发现并加入公开据点，而不是强制创建据点', () => {
    expect(onboarding).toContain("import DirectoryModal from './DirectoryModal.vue'")
    expect(onboarding).toContain('发现并加入据点')
    expect(onboarding).toContain('@click="showDirectory = true"')
    expect(onboarding).toContain('<DirectoryModal :open="showDirectory" @close="showDirectory = false" />')
  })

  it('加入成功刷新我的据点并选中新据点，同时仍保留创建入口', () => {
    expect(directoryModal).toContain('await api.joinStronghold(auth.token.value, entry.id)')
    expect(directoryModal).toContain('await loadStrongholds(true)')
    expect(directoryModal).toContain('selectedNodeId.value = entry.id')
    expect(onboarding).toContain('<CreateStrongholdCard />')
  })

  it('已登录但零成员关系时回退到公开目录，并区分公开预览与真实加入', () => {
    expect(strongholdState).toContain('const isPublicPreview = ref(false)')
    expect(strongholdState).toContain('const joinedNodeIds = ref<Set<string>>(new Set())')
    expect(strongholdState).toMatch(/memberNodes\.length === 0 && allowPublicPreview[\s\S]*replaceWithPublicDirectory\(\)/)
    expect(strongholdState).toContain('const entries = await api.getDirectory()')
    expect(strongholdState).toContain('if (selectedNodeId.value) void ensurePublicRooms(selectedNodeId.value)')
    expect(strongholdState).toContain('isPublicPreview.value = true')
    expect(strongholdState).toContain('const isReadOnly = computed(() => isGuestMode.value || (isPublicPreview.value && !authState.isAdmin.value))')
    expect(directoryModal).toContain("const { joinedNodeIds, selectedNodeId, loadStrongholds } = useStronghold()")
  })

  it('公开预览只读取聊天和帖子，不建立成员 WebSocket', () => {
    expect(chatRoom).toMatch(/\[selectedNodeId, selectedChannel, isReadOnly\]/)
    expect(chatRoom).toContain('if (readOnly || !auth.token.value)')
    expect(sectionRoom).toMatch(/\[selectedNodeId, selectedSection, isReadOnly\]/)
    expect(sectionRoom).toContain('if (readOnly || !auth.token.value) return')
  })

  it('公开预览隐藏写入口，并允许已登录用户直接加入当前据点', () => {
    expect(chatPane).toContain('const canParticipate = computed(() => auth.isAuthenticated.value && !isReadOnly.value)')
    expect(leftColumn).toContain('v-if="postRoom && canParticipate"')
    expect(postModal).toContain(':can-toggle="reactionsEnabled && canParticipate"')
    expect(rightColumn).toContain('v-else-if="isPublicPreview"')
    expect(rightColumn).toContain('@click="joinCurrentStronghold"')
    expect(rightColumn).toContain('await api.joinStronghold(auth.token.value, selectedNodeId.value)')
  })
})
