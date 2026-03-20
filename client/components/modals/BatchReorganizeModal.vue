<template>
  <modals-modal v-model="show" name="batchReorganize" :processing="processing" :width="500" :height="'unset'">
    <template #outer>
      <div class="absolute top-0 left-0 p-5 w-2/3 overflow-hidden">
        <p class="text-3xl text-white truncate">{{ title }}</p>
      </div>
    </template>

    <div ref="container" class="w-full rounded-lg bg-bg box-shadow-md overflow-y-auto overflow-x-hidden" style="max-height: 80vh">
      <div v-if="show" class="w-full h-full py-4">
        <div class="w-full overflow-y-auto overflow-x-hidden max-h-96">
          <p class="text-base px-8 py-4">{{ $strings.LabelToolsReorganizeFilesDescription }}</p>

          <div v-if="organizationPreview.length" class="px-8 py-2">
            <p class="text-sm font-semibold mb-2">{{ $strings.LabelPreview }}</p>
            <div class="bg-bg-secondary rounded p-3 max-h-48 overflow-y-auto">
              <div v-for="(preview, index) in organizationPreview" :key="index" class="text-xs mb-2">
                <p class="text-gray-400">{{ preview.title }}</p>
                <p class="text-green-400">{{ preview.newPath }}</p>
              </div>
            </div>
          </div>

          <div class="mt-4 pt-4 text-white/80 border-t border-white/5">
            <div class="flex items-center px-4">
              <ui-btn type="button" @click="show = false">{{ $strings.ButtonCancel }}</ui-btn>
              <div class="grow" />
              <ui-btn color="bg-success" :disabled="!selectedItemIds.length" @click="doBatchReorganize">
                {{ $strings.ButtonReorganizeFiles }}
              </ui-btn>
            </div>
          </div>
        </div>
      </div>
    </div>
  </modals-modal>
</template>

<script>
export default {
  data() {
    return {
      processing: false,
      loadedItems: []
    }
  },
  watch: {
    show: {
      handler(newVal) {
        if (newVal) {
          this.init()
        }
      }
    }
  },
  computed: {
    show: {
      get() {
        return this.$store.state.globals.showBatchReorganizeModal
      },
      set(val) {
        this.$store.commit('globals/setShowBatchReorganizeModal', val)
      }
    },
    title() {
      return this.$getString('MessageItemsSelected', [this.selectedItemIds.length])
    },
    selectedItemIds() {
      return (this.$store.state.globals.selectedMediaItems || []).map((i) => i.id)
    },
    selectedItems() {
      return this.loadedItems.length > 0 ? this.loadedItems : (this.$store.state.globals.selectedMediaItems || [])
    },
    organizationPreview() {
      // Show a preview of where files will be moved
      return this.selectedItems.slice(0, 5).map((item) => {
        let newPath = ''
        if (item.mediaType === 'podcast') {
          newPath = item.media?.metadata?.title || 'Unknown Podcast'
        } else {
          const parts = []
          if (item.media?.metadata?.authorName) parts.push(item.media.metadata.authorName)
          if (item.media?.metadata?.seriesName) parts.push(item.media.metadata.seriesName)
          if (item.media?.metadata?.title) parts.push(item.media.metadata.title)
          newPath = parts.join(' / ') || 'Unknown Item'
        }
        return {
          title: item.media?.metadata?.title || item.title,
          newPath
        }
      })
    }
  },
  mounted() {
    // Listen for batch reorganize completion
    this.$socket.on('batch_reorganize_complete', this.handleBatchComplete)
  },
  beforeDestroy() {
    this.$socket.off('batch_reorganize_complete', this.handleBatchComplete)
  },
  methods: {
    async init() {
      // Load full item data for preview
      this.loadedItems = []
      try {
        const libraryItems = await this.$axios.$post(`/api/items/batch/get`, {
          libraryItemIds: this.selectedItemIds
        })
        if (libraryItems && libraryItems.libraryItems) {
          this.loadedItems = libraryItems.libraryItems
        }
      } catch (error) {
        console.error('Failed to load items for preview', error)
      }
    },
    doBatchReorganize() {
      if (!this.selectedItemIds.length) return
      if (this.processing) return

      this.processing = true
      this.$store.commit('setProcessingBatch', true)
      this.$axios
        .$post(`/api/items/batch/reorganize-files`, {
          libraryItemIds: this.selectedItemIds
        })
        .then(() => {
          this.$toast.info(this.$getString('MessageBatchReorganizeStarted', [this.selectedItemIds.length]))
        })
        .catch((error) => {
          this.$toast.error('Failed to start batch reorganize')
          console.error('Failed to batch reorganize', error)
          this.processing = false
          this.$store.commit('setProcessingBatch', false)
        })
        .finally(() => {
          this.show = false
        })
    },
    handleBatchComplete(result) {
      this.processing = false
      this.$store.commit('setProcessingBatch', false)

      if (result.successCount > 0 && result.errorCount === 0) {
        this.$toast.success(this.$getString('MessageBatchReorganizeSuccess', [result.successCount]))
      } else if (result.successCount > 0 && result.errorCount > 0) {
        this.$toast.warning(this.$getString('MessageBatchReorganizePartial', [result.successCount, result.errorCount]))
      } else {
        this.$toast.error('Failed to reorganize files')
      }

      // Clear selection
      this.$store.commit('globals/resetSelectedMediaItems')
    }
  }
}
</script>
