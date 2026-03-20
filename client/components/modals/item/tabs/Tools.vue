<template>
  <div class="w-full h-full overflow-hidden overflow-y-auto px-4 py-6">
    <p class="text-xl font-semibold mb-2">{{ $strings.HeaderAudiobookTools }}</p>

    <!-- Merge to m4b -->
    <div v-if="showM4bDownload" class="w-full border border-black-200 p-4 my-8">
      <div class="flex flex-wrap items-center">
        <div>
          <p class="text-lg">{{ $strings.LabelToolsMakeM4b }}</p>
          <p class="max-w-sm text-sm pt-2 text-gray-300">{{ $strings.LabelToolsMakeM4bDescription }}</p>
        </div>
        <div class="grow" />
        <div>
          <ui-btn :to="`/audiobook/${libraryItemId}/manage?tool=m4b`" class="flex items-center"
            >{{ $strings.ButtonOpenManager }}
            <span class="material-symbols text-lg ml-2">launch</span>
          </ui-btn>
        </div>
      </div>
    </div>

    <!-- Embed Metadata -->
    <div v-if="mediaTracks.length" class="w-full border border-black-200 p-4 my-8">
      <div class="flex items-center">
        <div>
          <p class="text-lg">{{ $strings.LabelToolsEmbedMetadata }}</p>
          <p class="max-w-sm text-sm pt-2 text-gray-300">{{ $strings.LabelToolsEmbedMetadataDescription }}</p>
        </div>
        <div class="grow" />
        <div>
          <ui-btn :to="`/audiobook/${libraryItemId}/manage?tool=embed`" class="flex items-center"
            >{{ $strings.ButtonOpenManager }}
            <span class="material-symbols text-lg ml-2">launch</span>
          </ui-btn>

          <ui-btn v-if="!isMetadataEmbedQueued && !isEmbedTaskRunning" class="w-full mt-4" small @click.stop="quickEmbed">{{ $strings.ButtonQuickEmbed }}</ui-btn>
        </div>
      </div>

      <!-- queued alert -->
      <widgets-alert v-if="isMetadataEmbedQueued" type="warning" class="mt-4">
        <p class="text-lg">{{ $getString('MessageQuickEmbedQueue', [queuedEmbedLIds.length]) }}</p>
      </widgets-alert>

      <!-- processing alert -->
      <widgets-alert v-if="isEmbedTaskRunning" type="warning" class="mt-4">
        <p class="text-lg">{{ $strings.MessageQuickEmbedInProgress }}</p>
      </widgets-alert>
    </div>

    <p v-if="!mediaTracks.length" class="text-lg text-center my-8">{{ $strings.MessageNoAudioTracks }}</p>

    <!-- Reorganize Files -->
    <div class="w-full border border-black-200 p-4 my-8">
      <div class="flex items-center">
        <div>
          <p class="text-lg">{{ $strings.LabelToolsReorganizeFiles }}</p>
          <p class="max-w-sm text-sm pt-2 text-gray-300">{{ $strings.LabelToolsReorganizeFilesDescription }}</p>
        </div>
        <div class="grow" />
        <div>
          <ui-btn :loading="isReorganizing" color="bg-primary" @click.stop="reorganizeFiles">{{ $strings.ButtonReorganizeFiles }}</ui-btn>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  props: {
    processing: Boolean,
    libraryItem: {
      type: Object,
      default: () => {}
    }
  },
  data() {
    return {
      isReorganizing: false
    }
  },
  computed: {
    libraryItemId() {
      return this.libraryItem?.id || null
    },
    media() {
      return this.libraryItem?.media || {}
    },
    mediaTracks() {
      return this.media.tracks || []
    },
    chapters() {
      return this.media.chapters || []
    },
    showM4bDownload() {
      if (!this.mediaTracks.length) return false
      return true
    },
    queuedEmbedLIds() {
      return this.$store.state.tasks.queuedEmbedLIds || []
    },
    isMetadataEmbedQueued() {
      return this.queuedEmbedLIds.some((lid) => lid === this.libraryItemId)
    },
    tasks() {
      return this.$store.getters['tasks/getTasksByLibraryItemId'](this.libraryItemId)
    },
    embedTask() {
      return this.tasks.find((t) => t.action === 'embed-metadata')
    },
    encodeTask() {
      return this.tasks.find((t) => t.action === 'encode-m4b')
    },
    isEmbedTaskRunning() {
      return this.embedTask && !this.embedTask?.isFinished
    },
    isEncodeTaskRunning() {
      return this.encodeTask && !this.encodeTask?.isFinished
    }
  },
  methods: {
    quickEmbed() {
      const payload = {
        message: this.$strings.MessageConfirmQuickEmbed,
        allowHtml: true,
        callback: (confirmed) => {
          if (confirmed) {
            this.$axios
              .$post(`/api/tools/item/${this.libraryItemId}/embed-metadata`)
              .then(() => {
                console.log('Audio metadata encode started')
              })
              .catch((error) => {
                console.error('Audio metadata encode failed', error)
              })
          }
        },
        type: 'yesNo'
      }
      this.$store.commit('globals/setConfirmPrompt', payload)
    },
    async reorganizeFiles() {
      const title = this.libraryItem?.media?.metadata?.title || this.libraryItem?.media?.title || this.libraryItem?.title || 'this item'
      const payload = {
        message: `Are you sure you want to reorganize the files for "${title}"? Files will be moved to a directory structure based on metadata.`,
        callback: (confirmed) => {
          if (confirmed) {
            this.performReorganize()
          }
        },
        type: 'yesNo'
      }
      this.$store.commit('globals/setConfirmPrompt', payload)
    },
    async performReorganize() {
      this.isReorganizing = true
      try {
        const response = await this.$axios.$post(`/api/items/${this.libraryItemId}/reorganize-files`)
        console.log('Reorganize response:', response)
        this.$toast.success('Files reorganized successfully')
      } catch (error) {
        console.error('Reorganize error:', error)
        let errorMsg = 'Failed to reorganize files'
        if (error.response?.data) {
          errorMsg = error.response.data
        } else if (error.message) {
          errorMsg = error.message
        }
        this.$toast.error(errorMsg)
      } finally {
        this.isReorganizing = false
      }
    }
  }
}
</script>
