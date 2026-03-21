const { Request, Response, NextFunction } = require('express')
const Path = require('path')
const fs = require('../libs/fsExtra')
const uaParserJs = require('../libs/uaParser')
const Logger = require('../Logger')
const SocketAuthority = require('../SocketAuthority')
const Database = require('../Database')

const zipHelpers = require('../utils/zipHelpers')
const { reqSupportsWebp } = require('../utils/index')
const { ScanResult, AudioMimeType } = require('../utils/constants')
const { getAudioMimeTypeFromExtname, encodeUriPath, sanitizeFilename } = require('../utils/fileUtils')
const LibraryItemScanner = require('../scanner/LibraryItemScanner')
const AudioFileScanner = require('../scanner/AudioFileScanner')
const Scanner = require('../scanner/Scanner')

const RssFeedManager = require('../managers/RssFeedManager')
const CacheManager = require('../managers/CacheManager')
const CoverManager = require('../managers/CoverManager')
const ShareManager = require('../managers/ShareManager')

/**
 * @typedef RequestUserObject
 * @property {import('../models/User')} user
 *
 * @typedef {Request & RequestUserObject} RequestWithUser
 *
 * @typedef RequestEntityObject
 * @property {import('../models/LibraryItem')} libraryItem
 *
 * @typedef {RequestWithUser & RequestEntityObject} LibraryItemControllerRequest
 *
 * @typedef RequestLibraryFileObject
 * @property {import('../objects/files/LibraryFile')} libraryFile
 *
 * @typedef {RequestWithUser & RequestEntityObject & RequestLibraryFileObject} LibraryItemControllerRequestWithFile
 */

class LibraryItemController {
  constructor() {}

  /**
   * GET: /api/items/:id
   * Optional query params:
   * ?include=progress,rssfeed,downloads,share
   * ?expanded=1
   *
   * @param {LibraryItemControllerRequest} req
   * @param {Response} res
   */
  async findOne(req, res) {
    const includeEntities = (req.query.include || '').split(',')
    if (req.query.expanded == 1) {
      const item = req.libraryItem.toOldJSONExpanded()

      // Include users media progress
      if (includeEntities.includes('progress')) {
        const episodeId = req.query.episode || null
        item.userMediaProgress = req.user.getOldMediaProgress(item.id, episodeId)
      }

      if (includeEntities.includes('rssfeed')) {
        const feedData = await RssFeedManager.findFeedForEntityId(item.id)
        item.rssFeed = feedData?.toOldJSONMinified() || null
      }

      if (item.mediaType === 'book' && req.user.isAdminOrUp && includeEntities.includes('share')) {
        item.mediaItemShare = ShareManager.findByMediaItemId(item.media.id)
      }

      if (item.mediaType === 'podcast' && includeEntities.includes('downloads')) {
        const downloadsInQueue = this.podcastManager.getEpisodeDownloadsInQueue(req.libraryItem.id)
        item.episodeDownloadsQueued = downloadsInQueue.map((d) => d.toJSONForClient())
        if (this.podcastManager.currentDownload?.libraryItemId === req.libraryItem.id) {
          item.episodesDownloading = [this.podcastManager.currentDownload.toJSONForClient()]
        }
      }

      return res.json(item)
    }
    res.json(req.libraryItem.toOldJSON())
  }

  /**
   * DELETE: /api/items/:id
   * Delete library item. Will delete from database and file system if hard delete is requested.
   * Optional query params:
   * ?hard=1
   *
   * @this {import('../routers/ApiRouter')}
   *
   * @param {LibraryItemControllerRequest} req
   * @param {Response} res
   */
  async delete(req, res) {
    const hardDelete = req.query.hard == 1 // Delete from file system
    const libraryItemPath = req.libraryItem.path

    const mediaItemIds = []
    const authorIds = []
    const seriesIds = []
    if (req.libraryItem.isPodcast) {
      mediaItemIds.push(...req.libraryItem.media.podcastEpisodes.map((ep) => ep.id))
    } else {
      mediaItemIds.push(req.libraryItem.media.id)
      if (req.libraryItem.media.authors?.length) {
        authorIds.push(...req.libraryItem.media.authors.map((au) => au.id))
      }
      if (req.libraryItem.media.series?.length) {
        seriesIds.push(...req.libraryItem.media.series.map((se) => se.id))
      }
    }

    await this.handleDeleteLibraryItem(req.libraryItem.id, mediaItemIds)
    if (hardDelete) {
      Logger.info(`[LibraryItemController] Deleting library item from file system at "${libraryItemPath}"`)
      await fs.remove(libraryItemPath).catch((error) => {
        Logger.error(`[LibraryItemController] Failed to delete library item from file system at "${libraryItemPath}"`, error)
      })
    }

    if (authorIds.length) {
      await this.checkRemoveAuthorsWithNoBooks(authorIds)
    }
    if (seriesIds.length) {
      await this.checkRemoveEmptySeries(seriesIds)
    }

    await Database.resetLibraryIssuesFilterData(req.libraryItem.libraryId)
    res.sendStatus(200)
  }

  static handleDownloadError(error, res) {
    if (!res.headersSent) {
      if (error.code === 'ENOENT') {
        return res.status(404).send('File not found')
      } else {
        return res.status(500).send('Download failed')
      }
    }
  }

  /**
   * GET: /api/items/:id/download
   * Download library item. Zip file if multiple files.
   *
   * @param {LibraryItemControllerRequest} req
   * @param {Response} res
   */
  async download(req, res) {
    if (!req.user.canDownload) {
      Logger.warn(`User "${req.user.username}" attempted to download without permission`)
      return res.sendStatus(403)
    }
    const libraryItemPath = req.libraryItem.path
    const itemTitle = req.libraryItem.media.title

    Logger.info(`[LibraryItemController] User "${req.user.username}" requested download for item "${itemTitle}" at "${libraryItemPath}"`)

    try {
      // If library item is a single file in root dir then no need to zip
      if (req.libraryItem.isFile) {
        // Express does not set the correct mimetype for m4b files so use our defined mimetypes if available
        const audioMimeType = getAudioMimeTypeFromExtname(Path.extname(libraryItemPath))
        if (audioMimeType) {
          res.setHeader('Content-Type', audioMimeType)
        }
        await new Promise((resolve, reject) => res.download(libraryItemPath, req.libraryItem.relPath, (error) => (error ? reject(error) : resolve())))
      } else {
        const filename = `${itemTitle}.zip`
        await zipHelpers.zipDirectoryPipe(libraryItemPath, filename, res)
      }
      Logger.info(`[LibraryItemController] Downloaded item "${itemTitle}" at "${libraryItemPath}"`)
    } catch (error) {
      Logger.error(`[LibraryItemController] Download failed for item "${itemTitle}" at "${libraryItemPath}"`, error)
      LibraryItemController.handleDownloadError(error, res)
    }
  }

  /**
   * PATCH: /items/:id/media
   * Update media for a library item. Will create new authors & series when necessary
   *
   * @this {import('../routers/ApiRouter')}
   *
   * @param {LibraryItemControllerRequest} req
   * @param {Response} res
   */
  async updateMedia(req, res) {
    const mediaPayload = req.body

    if (mediaPayload.url) {
      await LibraryItemController.prototype.uploadCover.bind(this)(req, res, false)
      if (res.writableEnded || res.headersSent) return
    }

    // Podcast specific
    let isPodcastAutoDownloadUpdated = false
    if (req.libraryItem.isPodcast) {
      if (mediaPayload.autoDownloadEpisodes !== undefined && req.libraryItem.media.autoDownloadEpisodes !== mediaPayload.autoDownloadEpisodes) {
        isPodcastAutoDownloadUpdated = true
      } else if (mediaPayload.autoDownloadSchedule !== undefined && req.libraryItem.media.autoDownloadSchedule !== mediaPayload.autoDownloadSchedule) {
        isPodcastAutoDownloadUpdated = true
      }
    }

    let hasUpdates = (await req.libraryItem.media.updateFromRequest(mediaPayload)) || mediaPayload.url

    if (req.libraryItem.isBook && Array.isArray(mediaPayload.metadata?.series)) {
      const seriesUpdateData = await req.libraryItem.media.updateSeriesFromRequest(mediaPayload.metadata.series, req.libraryItem.libraryId)
      if (seriesUpdateData?.seriesRemoved.length) {
        // Check remove empty series
        Logger.debug(`[LibraryItemController] Series were removed from book. Check if series are now empty.`)
        await this.checkRemoveEmptySeries(seriesUpdateData.seriesRemoved.map((se) => se.id))
      }
      if (seriesUpdateData?.seriesAdded.length) {
        // Add series to filter data
        seriesUpdateData.seriesAdded.forEach((se) => {
          Database.addSeriesToFilterData(req.libraryItem.libraryId, se.name, se.id)
        })
      }
      if (seriesUpdateData?.hasUpdates) {
        hasUpdates = true
      }
    }

    if (req.libraryItem.isBook && Array.isArray(mediaPayload.metadata?.authors)) {
      const authorNames = mediaPayload.metadata.authors.map((au) => (typeof au.name === 'string' ? au.name.trim() : null)).filter((au) => au)
      const authorUpdateData = await req.libraryItem.media.updateAuthorsFromRequest(authorNames, req.libraryItem.libraryId)
      if (authorUpdateData?.authorsRemoved.length) {
        // Check remove empty authors
        Logger.debug(`[LibraryItemController] Authors were removed from book. Check if authors are now empty.`)
        await this.checkRemoveAuthorsWithNoBooks(authorUpdateData.authorsRemoved.map((au) => au.id))
        hasUpdates = true
      }
      if (authorUpdateData?.authorsAdded.length) {
        // Add authors to filter data
        authorUpdateData.authorsAdded.forEach((au) => {
          Database.addAuthorToFilterData(req.libraryItem.libraryId, au.name, au.id)
        })
        hasUpdates = true
      }
    }

    if (hasUpdates) {
      req.libraryItem.changed('updatedAt', true)
      await req.libraryItem.save()

      await req.libraryItem.saveMetadataFile()

      if (isPodcastAutoDownloadUpdated) {
        this.cronManager.checkUpdatePodcastCron(req.libraryItem)
      }

      Logger.debug(`[LibraryItemController] Updated library item media ${req.libraryItem.media.title}`)
      SocketAuthority.libraryItemEmitter('item_updated', req.libraryItem)
    }
    res.json({
      updated: hasUpdates,
      libraryItem: req.libraryItem.toOldJSON()
    })
  }

  /**
   * POST: /api/items/:id/cover
   *
   * @param {LibraryItemControllerRequest} req
   * @param {Response} res
   * @param {boolean} [updateAndReturnJson=true] - Allows the function to be used for both direct API calls and internally
   */
  async uploadCover(req, res, updateAndReturnJson = true) {
    if (!req.user.canUpload) {
      Logger.warn(`User "${req.user.username}" attempted to upload a cover without permission`)
      return res.sendStatus(403)
    }

    let result = null
    if (req.body?.url) {
      Logger.debug(`[LibraryItemController] Requesting download cover from url "${req.body.url}"`)
      result = await CoverManager.downloadCoverFromUrlNew(req.body.url, req.libraryItem.id, req.libraryItem.isFile ? null : req.libraryItem.path)
    } else if (req.files?.cover) {
      Logger.debug(`[LibraryItemController] Handling uploaded cover`)
      result = await CoverManager.uploadCover(req.libraryItem, req.files.cover)
    } else {
      return res.status(400).send('Invalid request no file or url')
    }

    if (result?.error) {
      return res.status(400).send(result.error)
    } else if (!result?.cover) {
      return res.status(500).send('Unknown error occurred')
    }

    req.libraryItem.media.coverPath = result.cover
    req.libraryItem.media.changed('coverPath', true)
    await req.libraryItem.media.save()

    if (updateAndReturnJson) {
      // client uses updatedAt timestamp in URL to force refresh cover
      req.libraryItem.changed('updatedAt', true)
      await req.libraryItem.save()

      SocketAuthority.libraryItemEmitter('item_updated', req.libraryItem)
      res.json({
        success: true,
        cover: result.cover
      })
    }
  }

  /**
   * PATCH: /api/items/:id/cover
   *
   * @param {LibraryItemControllerRequest} req
   * @param {Response} res
   */
  async updateCover(req, res) {
    if (!req.body.cover) {
      return res.status(400).send('Invalid request no cover path')
    }

    const validationResult = await CoverManager.validateCoverPath(req.body.cover, req.libraryItem)
    if (validationResult.error) {
      return res.status(500).send(validationResult.error)
    }
    if (validationResult.updated) {
      req.libraryItem.media.coverPath = validationResult.cover
      req.libraryItem.media.changed('coverPath', true)
      await req.libraryItem.media.save()

      // client uses updatedAt timestamp in URL to force refresh cover
      req.libraryItem.changed('updatedAt', true)
      await req.libraryItem.save()

      SocketAuthority.libraryItemEmitter('item_updated', req.libraryItem)
    }
    res.json({
      success: true,
      cover: validationResult.cover
    })
  }

  /**
   * DELETE: /api/items/:id/cover
   *
   * @param {LibraryItemControllerRequest} req
   * @param {Response} res
   */
  async removeCover(req, res) {
    if (req.libraryItem.media.coverPath) {
      req.libraryItem.media.coverPath = null
      req.libraryItem.media.changed('coverPath', true)
      await req.libraryItem.media.save()

      // client uses updatedAt timestamp in URL to force refresh cover
      req.libraryItem.changed('updatedAt', true)
      await req.libraryItem.save()

      await CacheManager.purgeCoverCache(req.libraryItem.id)

      SocketAuthority.libraryItemEmitter('item_updated', req.libraryItem)
    }

    res.sendStatus(200)
  }

  /**
   * GET: /api/items/:id/cover
   *
   * @param {LibraryItemControllerRequest} req
   * @param {Response} res
   */
  async getCover(req, res) {
    const {
      query: { width, height, format, raw }
    } = req

    if (req.query.ts) res.set('Cache-Control', 'private, max-age=86400')

    const libraryItemId = req.params.id
    if (!libraryItemId) {
      return res.sendStatus(400)
    }

    if (raw) {
      const coverPath = await Database.libraryItemModel.getCoverPath(libraryItemId)
      if (!coverPath || !(await fs.pathExists(coverPath))) {
        return res.sendStatus(404)
      }
      // any value
      if (global.XAccel) {
        const encodedURI = encodeUriPath(global.XAccel + coverPath)
        Logger.debug(`Use X-Accel to serve static file ${encodedURI}`)
        return res.status(204).header({ 'X-Accel-Redirect': encodedURI }).send()
      }
      return res.sendFile(coverPath)
    }

    const options = {
      format: format || (reqSupportsWebp(req) ? 'webp' : 'jpeg'),
      height: height ? parseInt(height) : null,
      width: width ? parseInt(width) : null
    }
    return CacheManager.handleCoverCache(res, libraryItemId, options)
  }

  /**
   * POST: /api/items/:id/play
   *
   * @this {import('../routers/ApiRouter')}
   *
   * @param {LibraryItemControllerRequest} req
   * @param {Response} res
   */
  startPlaybackSession(req, res) {
    if (!req.libraryItem.hasAudioTracks) {
      Logger.error(`[LibraryItemController] startPlaybackSession cannot playback ${req.libraryItem.id}`)
      return res.sendStatus(404)
    }

    this.playbackSessionManager.startSessionRequest(req, res, null)
  }

  /**
   * POST: /api/items/:id/play/:episodeId
   *
   * @this {import('../routers/ApiRouter')}
   *
   * @param {LibraryItemControllerRequest} req
   * @param {Response} res
   */
  startEpisodePlaybackSession(req, res) {
    if (!req.libraryItem.isPodcast) {
      Logger.error(`[LibraryItemController] startEpisodePlaybackSession invalid media type ${req.libraryItem.id}`)
      return res.sendStatus(400)
    }

    const episodeId = req.params.episodeId
    if (!req.libraryItem.media.podcastEpisodes.some((ep) => ep.id === episodeId)) {
      Logger.error(`[LibraryItemController] startPlaybackSession episode ${episodeId} not found for item ${req.libraryItem.id}`)
      return res.sendStatus(404)
    }

    this.playbackSessionManager.startSessionRequest(req, res, episodeId)
  }

  /**
   * PATCH: /api/items/:id/tracks
   *
   * @param {LibraryItemControllerRequest} req
   * @param {Response} res
   */
  async updateTracks(req, res) {
    const orderedFileData = req.body?.orderedFileData

    if (!req.libraryItem.isBook) {
      Logger.error(`[LibraryItemController] updateTracks invalid media type ${req.libraryItem.id}`)
      return res.sendStatus(400)
    }
    if (!Array.isArray(orderedFileData) || !orderedFileData.length) {
      Logger.error(`[LibraryItemController] updateTracks invalid orderedFileData ${req.libraryItem.id}`)
      return res.sendStatus(400)
    }
    // Ensure that each orderedFileData has a valid ino and is in the book audioFiles
    if (orderedFileData.some((fileData) => !fileData?.ino || !req.libraryItem.media.audioFiles.some((af) => af.ino === fileData.ino))) {
      Logger.error(`[LibraryItemController] updateTracks invalid orderedFileData ${req.libraryItem.id}`)
      return res.sendStatus(400)
    }

    let index = 1
    const updatedAudioFiles = orderedFileData.map((fileData) => {
      const audioFile = req.libraryItem.media.audioFiles.find((af) => af.ino === fileData.ino)
      audioFile.manuallyVerified = true
      audioFile.exclude = !!fileData.exclude
      if (audioFile.exclude) {
        audioFile.index = -1
      } else {
        audioFile.index = index++
      }
      return audioFile
    })
    updatedAudioFiles.sort((a, b) => a.index - b.index)

    req.libraryItem.media.audioFiles = updatedAudioFiles
    req.libraryItem.media.changed('audioFiles', true)
    await req.libraryItem.media.save()

    SocketAuthority.libraryItemEmitter('item_updated', req.libraryItem)
    res.json(req.libraryItem.toOldJSON())
  }

  /**
   * POST /api/items/:id/reorganize-files
   * Reorganize library item files into metadata-based directory structure
   *
   * @param {LibraryItemControllerRequest} req
   * @param {Response} res
   */
  async reorganizeFiles(req, res) {
    if (!req.user.canUpdate) {
      Logger.warn(`[LibraryItemController] User "${req.user.username}" attempted to reorganize files without permission`)
      return res.sendStatus(403)
    }

    try {
      const result = await this.reorganizeFilesForItem(req.libraryItem)
      
      if (!result.success) {
        return res.status(400).send(`Error: ${result.error}`)
      }

      Logger.info(`[LibraryItemController] reorganizeFiles completed successfully`)
      res.json({ success: true })
    } catch (error) {
      Logger.error(`[LibraryItemController] reorganizeFiles error: ${error.message}`)
      res.status(400).send(`Error: ${error.message}`)
    }
  }

  /**
   * POST /api/items/:id/match
   *
   * @param {LibraryItemControllerRequest} req
   * @param {Response} res
   */
  async match(req, res) {
    const reqBody = req.body || {}

    const options = {}
    const matchOptions = ['provider', 'title', 'author', 'isbn', 'asin']
    for (const key of matchOptions) {
      if (reqBody[key] && typeof reqBody[key] === 'string') {
        options[key] = reqBody[key]
      }
    }
    if (reqBody.overrideCover !== undefined) {
      options.overrideCover = !!reqBody.overrideCover
    }
    if (reqBody.overrideDetails !== undefined) {
      options.overrideDetails = !!reqBody.overrideDetails
    }

    const matchResult = await Scanner.quickMatchLibraryItem(this, req.libraryItem, options)
    res.json(matchResult)
  }

  /**
   * POST: /api/items/batch/delete
   * Batch delete library items. Will delete from database and file system if hard delete is requested.
   * Optional query params:
   * ?hard=1
   *
   * @this {import('../routers/ApiRouter')}
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async batchDelete(req, res) {
    if (!req.user.canDelete) {
      Logger.warn(`[LibraryItemController] User "${req.user.username}" attempted to delete without permission`)
      return res.sendStatus(403)
    }
    const hardDelete = req.query.hard == 1 // Delete files from filesystem

    const { libraryItemIds } = req.body
    if (!libraryItemIds?.length || !Array.isArray(libraryItemIds)) {
      return res.status(400).send('Invalid request body')
    }

    const itemsToDelete = await Database.libraryItemModel.findAllExpandedWhere({
      id: libraryItemIds
    })

    if (!itemsToDelete.length) {
      return res.sendStatus(404)
    }

    const libraryId = itemsToDelete[0].libraryId
    for (const libraryItem of itemsToDelete) {
      const libraryItemPath = libraryItem.path
      Logger.info(`[LibraryItemController] (${hardDelete ? 'Hard' : 'Soft'}) deleting Library Item "${libraryItem.media.title}" with id "${libraryItem.id}"`)
      const mediaItemIds = []
      const seriesIds = []
      const authorIds = []
      if (libraryItem.isPodcast) {
        mediaItemIds.push(...libraryItem.media.podcastEpisodes.map((ep) => ep.id))
      } else {
        mediaItemIds.push(libraryItem.media.id)
        if (libraryItem.media.series?.length) {
          seriesIds.push(...libraryItem.media.series.map((se) => se.id))
        }
        if (libraryItem.media.authors?.length) {
          authorIds.push(...libraryItem.media.authors.map((au) => au.id))
        }
      }
      await this.handleDeleteLibraryItem(libraryItem.id, mediaItemIds)
      if (hardDelete) {
        Logger.info(`[LibraryItemController] Deleting library item from file system at "${libraryItemPath}"`)
        await fs.remove(libraryItemPath).catch((error) => {
          Logger.error(`[LibraryItemController] Failed to delete library item from file system at "${libraryItemPath}"`, error)
        })
      }
      if (seriesIds.length) {
        await this.checkRemoveEmptySeries(seriesIds)
      }
      if (authorIds.length) {
        await this.checkRemoveAuthorsWithNoBooks(authorIds)
      }
    }

    await Database.resetLibraryIssuesFilterData(libraryId)
    res.sendStatus(200)
  }

  /**
   * POST: /api/items/batch/update
   *
   * @this {import('../routers/ApiRouter')}
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async batchUpdate(req, res) {
    const updatePayloads = req.body
    if (!Array.isArray(updatePayloads) || !updatePayloads.length) {
      Logger.error(`[LibraryItemController] Batch update failed. Invalid payload`)
      return res.sendStatus(400)
    }

    // Ensure that each update payload has a unique library item id
    const libraryItemIds = [...new Set(updatePayloads.map((up) => up?.id).filter((id) => id))]
    if (!libraryItemIds.length || libraryItemIds.length !== updatePayloads.length) {
      Logger.error(`[LibraryItemController] Batch update failed. Each update payload must have a unique library item id`)
      return res.sendStatus(400)
    }

    // Get all library items to update
    const libraryItems = await Database.libraryItemModel.findAllExpandedWhere({
      id: libraryItemIds
    })
    if (updatePayloads.length !== libraryItems.length) {
      Logger.error(`[LibraryItemController] Batch update failed. Not all library items found`)
      return res.sendStatus(404)
    }

    let itemsUpdated = 0

    const seriesIdsRemoved = []
    const authorIdsRemoved = []

    for (const updatePayload of updatePayloads) {
      const mediaPayload = updatePayload.mediaPayload
      const libraryItem = libraryItems.find((li) => li.id === updatePayload.id)

      let hasUpdates = await libraryItem.media.updateFromRequest(mediaPayload)

      if (libraryItem.isBook && Array.isArray(mediaPayload.metadata?.series)) {
        const seriesUpdateData = await libraryItem.media.updateSeriesFromRequest(mediaPayload.metadata.series, libraryItem.libraryId)
        if (seriesUpdateData?.seriesRemoved.length) {
          seriesIdsRemoved.push(...seriesUpdateData.seriesRemoved.map((se) => se.id))
        }
        if (seriesUpdateData?.seriesAdded.length) {
          seriesUpdateData.seriesAdded.forEach((se) => {
            Database.addSeriesToFilterData(libraryItem.libraryId, se.name, se.id)
          })
        }
        if (seriesUpdateData?.hasUpdates) {
          hasUpdates = true
        }
      }

      if (libraryItem.isBook && Array.isArray(mediaPayload.metadata?.authors)) {
        const authorNames = mediaPayload.metadata.authors.map((au) => (typeof au.name === 'string' ? au.name.trim() : null)).filter((au) => au)
        const authorUpdateData = await libraryItem.media.updateAuthorsFromRequest(authorNames, libraryItem.libraryId)
        if (authorUpdateData?.authorsRemoved.length) {
          authorIdsRemoved.push(...authorUpdateData.authorsRemoved.map((au) => au.id))
          hasUpdates = true
        }
        if (authorUpdateData?.authorsAdded.length) {
          authorUpdateData.authorsAdded.forEach((au) => {
            Database.addAuthorToFilterData(libraryItem.libraryId, au.name, au.id)
          })
          hasUpdates = true
        }
      }

      if (hasUpdates) {
        libraryItem.changed('updatedAt', true)
        await libraryItem.save()

        await libraryItem.saveMetadataFile()

        Logger.debug(`[LibraryItemController] Updated library item media "${libraryItem.media.title}"`)
        SocketAuthority.libraryItemEmitter('item_updated', libraryItem)
        itemsUpdated++
      }
    }

    if (seriesIdsRemoved.length) {
      await this.checkRemoveEmptySeries(seriesIdsRemoved)
    }
    if (authorIdsRemoved.length) {
      await this.checkRemoveAuthorsWithNoBooks(authorIdsRemoved)
    }

    res.json({
      success: true,
      updates: itemsUpdated
    })
  }

  /**
   * POST: /api/items/batch/get
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async batchGet(req, res) {
    const libraryItemIds = req.body.libraryItemIds || []
    if (!libraryItemIds.length) {
      return res.status(403).send('Invalid payload')
    }
    const libraryItems = await Database.libraryItemModel.findAllExpandedWhere({
      id: libraryItemIds
    })
    res.json({
      libraryItems: libraryItems.map((li) => li.toOldJSONExpanded())
    })
  }

  /**
   * POST: /api/items/batch/quickmatch
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async batchQuickMatch(req, res) {
    if (!req.user.isAdminOrUp) {
      Logger.warn(`Non-admin user "${req.user.username}" other than admin attempted to batch quick match library items`)
      return res.sendStatus(403)
    }

    let itemsUpdated = 0
    let itemsUnmatched = 0

    if (!req.body.libraryItemIds?.length) {
      return res.sendStatus(400)
    }

    const libraryItems = await Database.libraryItemModel.findAllExpandedWhere({
      id: req.body.libraryItemIds
    })
    if (!libraryItems?.length) {
      return res.sendStatus(400)
    }

    res.sendStatus(200)

    const reqBodyOptions = req.body.options || {}
    const options = {}
    if (reqBodyOptions.provider && typeof reqBodyOptions.provider === 'string') {
      options.provider = reqBodyOptions.provider
    }
    if (reqBodyOptions.overrideCover !== undefined) {
      options.overrideCover = !!reqBodyOptions.overrideCover
    }
    if (reqBodyOptions.overrideDetails !== undefined) {
      options.overrideDetails = !!reqBodyOptions.overrideDetails
    }

    for (const libraryItem of libraryItems) {
      const matchResult = await Scanner.quickMatchLibraryItem(this, libraryItem, options)
      if (matchResult.updated) {
        itemsUpdated++
      } else if (matchResult.warning) {
        itemsUnmatched++
      }
    }

    const result = {
      success: itemsUpdated > 0,
      updates: itemsUpdated,
      unmatched: itemsUnmatched
    }
    SocketAuthority.clientEmitter(req.user.id, 'batch_quickmatch_complete', result)
  }

  /**
   * POST: /api/items/batch/scan
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async batchScan(req, res) {
    if (!req.user.isAdminOrUp) {
      Logger.warn(`Non-admin user "${req.user.username}" other than admin attempted to batch scan library items`)
      return res.sendStatus(403)
    }

    if (!req.body.libraryItemIds?.length) {
      return res.sendStatus(400)
    }

    const libraryItems = await Database.libraryItemModel.findAll({
      where: {
        id: req.body.libraryItemIds
      },
      attributes: ['id', 'libraryId', 'isFile']
    })
    if (!libraryItems?.length) {
      return res.sendStatus(400)
    }

    res.sendStatus(200)

    const libraryId = libraryItems[0].libraryId
    for (const libraryItem of libraryItems) {
      if (libraryItem.isFile) {
        Logger.warn(`[LibraryItemController] Re-scanning file library items not yet supported`)
      } else {
        await LibraryItemScanner.scanLibraryItem(libraryItem.id)
      }
    }

    await Database.resetLibraryIssuesFilterData(libraryId)
  }

  /**
   * POST: /api/items/:id/scan
   *
   * @param {LibraryItemControllerRequest} req
   * @param {Response} res
   */
  async scan(req, res) {
    if (!req.user.isAdminOrUp) {
      Logger.error(`[LibraryItemController] Non-admin user "${req.user.username}" attempted to scan library item`)
      return res.sendStatus(403)
    }

    if (req.libraryItem.isFile) {
      Logger.error(`[LibraryItemController] Re-scanning file library items not yet supported`)
      return res.sendStatus(500)
    }

    const result = await LibraryItemScanner.scanLibraryItem(req.libraryItem.id)
    await Database.resetLibraryIssuesFilterData(req.libraryItem.libraryId)
    res.json({
      result: Object.keys(ScanResult).find((key) => ScanResult[key] == result)
    })
  }

  /**
   * GET: /api/items/:id/metadata-object
   *
   * @param {LibraryItemControllerRequest} req
   * @param {Response} res
   */
  getMetadataObject(req, res) {
    if (!req.user.isAdminOrUp) {
      Logger.error(`[LibraryItemController] Non-admin user "${req.user.username}" attempted to get metadata object`)
      return res.sendStatus(403)
    }

    if (req.libraryItem.isMissing || !req.libraryItem.isBook || !req.libraryItem.media.includedAudioFiles.length) {
      Logger.error(`[LibraryItemController] getMetadataObject: Invalid library item "${req.libraryItem.media.title}"`)
      return res.sendStatus(400)
    }

    res.json(this.audioMetadataManager.getMetadataObjectForApi(req.libraryItem))
  }

  /**
   * POST: /api/items/:id/chapters
   *
   * @param {LibraryItemControllerRequest} req
   * @param {Response} res
   */
  async updateMediaChapters(req, res) {
    if (!req.user.canUpdate) {
      Logger.error(`[LibraryItemController] User "${req.user.username}" attempted to update chapters with invalid permissions`)
      return res.sendStatus(403)
    }

    if (req.libraryItem.isMissing || !req.libraryItem.isBook || !req.libraryItem.media.hasAudioTracks) {
      Logger.error(`[LibraryItemController] Invalid library item`)
      return res.sendStatus(500)
    }

    if (!Array.isArray(req.body.chapters) || req.body.chapters.some((c) => !c.title || typeof c.title !== 'string' || c.start === undefined || typeof c.start !== 'number' || c.end === undefined || typeof c.end !== 'number')) {
      Logger.error(`[LibraryItemController] Invalid payload`)
      return res.sendStatus(400)
    }

    const chapters = req.body.chapters || []

    let hasUpdates = false
    if (chapters.length !== req.libraryItem.media.chapters.length) {
      req.libraryItem.media.chapters = chapters.map((c, index) => {
        return {
          id: index,
          title: c.title,
          start: c.start,
          end: c.end
        }
      })
      hasUpdates = true
    } else {
      for (const [index, chapter] of chapters.entries()) {
        const currentChapter = req.libraryItem.media.chapters[index]
        if (currentChapter.title !== chapter.title || currentChapter.start !== chapter.start || currentChapter.end !== chapter.end) {
          currentChapter.title = chapter.title
          currentChapter.start = chapter.start
          currentChapter.end = chapter.end
          hasUpdates = true
        }
      }
    }

    if (hasUpdates) {
      req.libraryItem.media.changed('chapters', true)
      await req.libraryItem.media.save()

      await req.libraryItem.saveMetadataFile()

      SocketAuthority.libraryItemEmitter('item_updated', req.libraryItem)
    }

    res.json({
      success: true,
      updated: hasUpdates
    })
  }

  /**
   * GET: /api/items/:id/ffprobe/:fileid
   * FFProbe JSON result from audio file
   *
   * @param {LibraryItemControllerRequest} req
   * @param {Response} res
   */
  async getFFprobeData(req, res) {
    if (!req.user.isAdminOrUp) {
      Logger.error(`[LibraryItemController] Non-admin user "${req.user.username}" attempted to get ffprobe data`)
      return res.sendStatus(403)
    }

    const audioFile = req.libraryItem.getAudioFileWithIno(req.params.fileid)
    if (!audioFile) {
      Logger.error(`[LibraryItemController] Audio file not found with inode value ${req.params.fileid}`)
      return res.sendStatus(404)
    }

    const ffprobeData = await AudioFileScanner.probeAudioFile(audioFile.metadata.path)
    res.json(ffprobeData)
  }

  /**
   * GET api/items/:id/file/:fileid
   *
   * @param {LibraryItemControllerRequestWithFile} req
   * @param {Response} res
   */
  async getLibraryFile(req, res) {
    const libraryFile = req.libraryFile

    if (global.XAccel) {
      const encodedURI = encodeUriPath(global.XAccel + libraryFile.metadata.path)
      Logger.debug(`Use X-Accel to serve static file ${encodedURI}`)
      return res.status(204).header({ 'X-Accel-Redirect': encodedURI }).send()
    }

    // Express does not set the correct mimetype for m4b files so use our defined mimetypes if available
    const audioMimeType = getAudioMimeTypeFromExtname(Path.extname(libraryFile.metadata.path))
    if (audioMimeType) {
      res.setHeader('Content-Type', audioMimeType)
    }
    res.sendFile(libraryFile.metadata.path)
  }

  /**
   * DELETE api/items/:id/file/:fileid
   *
   * @param {LibraryItemControllerRequestWithFile} req
   * @param {Response} res
   */
  async deleteLibraryFile(req, res) {
    const libraryFile = req.libraryFile

    Logger.info(`[LibraryItemController] User "${req.user.username}" requested file delete at "${libraryFile.metadata.path}"`)

    await fs.remove(libraryFile.metadata.path).catch((error) => {
      Logger.error(`[LibraryItemController] Failed to delete library file at "${libraryFile.metadata.path}"`, error)
    })

    req.libraryItem.libraryFiles = req.libraryItem.libraryFiles.filter((lf) => lf.ino !== req.params.fileid)
    req.libraryItem.changed('libraryFiles', true)

    if (req.libraryItem.isBook) {
      if (req.libraryItem.media.audioFiles.some((af) => af.ino === req.params.fileid)) {
        req.libraryItem.media.audioFiles = req.libraryItem.media.audioFiles.filter((af) => af.ino !== req.params.fileid)
        req.libraryItem.media.changed('audioFiles', true)
      } else if (req.libraryItem.media.ebookFile?.ino === req.params.fileid) {
        req.libraryItem.media.ebookFile = null
        req.libraryItem.media.changed('ebookFile', true)
      }
      if (!req.libraryItem.media.hasMediaFiles) {
        req.libraryItem.isMissing = true
      }
    } else if (req.libraryItem.media.podcastEpisodes.some((ep) => ep.audioFile.ino === req.params.fileid)) {
      const episodeToRemove = req.libraryItem.media.podcastEpisodes.find((ep) => ep.audioFile.ino === req.params.fileid)
      // Remove episode from all playlists
      await Database.playlistModel.removeMediaItemsFromPlaylists([episodeToRemove.id])

      // Remove episode media progress
      const numProgressRemoved = await Database.mediaProgressModel.destroy({
        where: {
          mediaItemId: episodeToRemove.id
        }
      })
      if (numProgressRemoved > 0) {
        Logger.info(`[LibraryItemController] Removed media progress for episode ${episodeToRemove.id}`)
      }

      // Remove episode
      await episodeToRemove.destroy()

      req.libraryItem.media.podcastEpisodes = req.libraryItem.media.podcastEpisodes.filter((ep) => ep.audioFile.ino !== req.params.fileid)
    }

    if (req.libraryItem.media.changed()) {
      await req.libraryItem.media.save()
    }

    await req.libraryItem.save()

    SocketAuthority.libraryItemEmitter('item_updated', req.libraryItem)
    res.sendStatus(200)
  }

  /**
   * GET api/items/:id/file/:fileid/download
   * Same as GET api/items/:id/file/:fileid but allows logging and restricting downloads
   *
   * @param {LibraryItemControllerRequestWithFile} req
   * @param {Response} res
   */
  async downloadLibraryFile(req, res) {
    const libraryFile = req.libraryFile
    const ua = uaParserJs(req.headers['user-agent'])

    if (!req.user.canDownload) {
      Logger.error(`[LibraryItemController] User "${req.user.username}" without download permission attempted to download file "${libraryFile.metadata.path}"`)
      return res.sendStatus(403)
    }

    Logger.info(`[LibraryItemController] User "${req.user.username}" requested download for item "${req.libraryItem.media.title}" file at "${libraryFile.metadata.path}"`)

    if (global.XAccel) {
      const encodedURI = encodeUriPath(global.XAccel + libraryFile.metadata.path)
      Logger.debug(`Use X-Accel to serve static file ${encodedURI}`)
      return res.status(204).header({ 'X-Accel-Redirect': encodedURI }).send()
    }

    // Express does not set the correct mimetype for m4b files so use our defined mimetypes if available
    let audioMimeType = getAudioMimeTypeFromExtname(Path.extname(libraryFile.metadata.path))
    if (audioMimeType) {
      // Work-around for Apple devices mishandling Content-Type on mobile browsers:
      // https://github.com/advplyr/audiobookshelf/issues/3310
      // We actually need to check for Webkit on Apple mobile devices because this issue impacts all browsers on iOS/iPadOS/etc, not just Safari.
      const isAppleMobileBrowser = ua.device.vendor === 'Apple' && ua.device.type === 'mobile' && ua.engine.name === 'WebKit'
      if (isAppleMobileBrowser && audioMimeType === AudioMimeType.M4B) {
        audioMimeType = 'audio/m4b'
      }
      res.setHeader('Content-Type', audioMimeType)
    }

    try {
      await new Promise((resolve, reject) => res.download(libraryFile.metadata.path, libraryFile.metadata.filename, (error) => (error ? reject(error) : resolve())))
      Logger.info(`[LibraryItemController] Downloaded file "${libraryFile.metadata.path}"`)
    } catch (error) {
      Logger.error(`[LibraryItemController] Failed to download file "${libraryFile.metadata.path}"`, error)
      LibraryItemController.handleDownloadError(error, res)
    }
  }

  /**
   * GET api/items/:id/ebook/:fileid?
   * fileid is the inode value stored in LibraryFile.ino or EBookFile.ino
   * fileid is only required when reading a supplementary ebook
   * when no fileid is passed in the primary ebook will be returned
   *
   * @param {LibraryItemControllerRequest} req
   * @param {Response} res
   */
  async getEBookFile(req, res) {
    let ebookFile = null
    if (req.params.fileid) {
      ebookFile = req.libraryItem.getLibraryFileWithIno(req.params.fileid)
      if (!ebookFile?.isEBookFile) {
        Logger.error(`[LibraryItemController] Invalid ebook file id "${req.params.fileid}"`)
        return res.status(400).send('Invalid ebook file id')
      }
    } else {
      ebookFile = req.libraryItem.media.ebookFile
    }

    if (!ebookFile) {
      Logger.error(`[LibraryItemController] No ebookFile for library item "${req.libraryItem.media.title}"`)
      return res.sendStatus(404)
    }
    const ebookFilePath = ebookFile.metadata.path

    Logger.info(`[LibraryItemController] User "${req.user.username}" requested download for item "${req.libraryItem.media.title}" ebook at "${ebookFilePath}"`)

    if (global.XAccel) {
      const encodedURI = encodeUriPath(global.XAccel + ebookFilePath)
      Logger.debug(`Use X-Accel to serve static file ${encodedURI}`)
      return res.status(204).header({ 'X-Accel-Redirect': encodedURI }).send()
    }

    try {
      await new Promise((resolve, reject) => res.sendFile(ebookFilePath, (error) => (error ? reject(error) : resolve())))
      Logger.info(`[LibraryItemController] Downloaded ebook file "${ebookFilePath}"`)
    } catch (error) {
      Logger.error(`[LibraryItemController] Failed to download ebook file "${ebookFilePath}"`, error)
      LibraryItemController.handleDownloadError(error, res)
    }
  }

  /**
   * PATCH api/items/:id/ebook/:fileid/status
   * toggle the status of an ebook file.
   * if an ebook file is the primary ebook, then it will be changed to supplementary
   * if an ebook file is supplementary, then it will be changed to primary
   *
   * @param {LibraryItemControllerRequestWithFile} req
   * @param {Response} res
   */
  async updateEbookFileStatus(req, res) {
    if (!req.libraryItem.isBook) {
      Logger.error(`[LibraryItemController] Invalid media type for ebook file status update`)
      return res.sendStatus(400)
    }
    if (!req.libraryFile?.isEBookFile) {
      Logger.error(`[LibraryItemController] Invalid ebook file id "${req.params.fileid}"`)
      return res.status(400).send('Invalid ebook file id')
    }

    const ebookLibraryFile = req.libraryFile
    let primaryEbookFile = null

    const ebookLibraryFileInos = req.libraryItem
      .getLibraryFiles()
      .filter((lf) => lf.isEBookFile)
      .map((lf) => lf.ino)

    if (ebookLibraryFile.isSupplementary) {
      Logger.info(`[LibraryItemController] Updating ebook file "${ebookLibraryFile.metadata.filename}" to primary`)

      primaryEbookFile = ebookLibraryFile.toJSON()
      delete primaryEbookFile.isSupplementary
      delete primaryEbookFile.fileType
      primaryEbookFile.ebookFormat = ebookLibraryFile.metadata.format
    } else {
      Logger.info(`[LibraryItemController] Updating ebook file "${ebookLibraryFile.metadata.filename}" to supplementary`)
    }

    req.libraryItem.media.ebookFile = primaryEbookFile
    req.libraryItem.media.changed('ebookFile', true)
    await req.libraryItem.media.save()

    req.libraryItem.libraryFiles = req.libraryItem.libraryFiles.map((lf) => {
      if (ebookLibraryFileInos.includes(lf.ino)) {
        lf.isSupplementary = lf.ino !== primaryEbookFile?.ino
      }
      return lf
    })
    req.libraryItem.changed('libraryFiles', true)

    req.libraryItem.isMissing = !req.libraryItem.media.hasMediaFiles

    await req.libraryItem.save()

    SocketAuthority.libraryItemEmitter('item_updated', req.libraryItem)
    res.sendStatus(200)
  }

  /**
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   * @param {NextFunction} next
   */

  /**
   * Helper method to reorganize a single item's files
   * @param {import('../models/LibraryItem')} libraryItem
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async reorganizeFilesForItem(libraryItem) {
    try {
      const itemId = libraryItem.id
      const currentPath = libraryItem.path
      const libraryId = libraryItem.libraryId
      const isBook = libraryItem.isBook
      const isPodcast = libraryItem.isPodcast

      Logger.info(`[LibraryItemController] Reorganizing item ${itemId}`)

      // Get library folder early for error directory path
      const library = await Database.libraryModel.findByIdWithFolders(libraryId)
      if (!library || !library.libraryFolders || !library.libraryFolders.length) {
        return { success: false, error: 'Library not found' }
      }

      const libraryFolder = library.libraryFolders.find((f) => currentPath.startsWith(f.path))
      if (!libraryFolder) {
        return { success: false, error: 'Library folder not found' }
      }

      // Refresh metadata before reorganizing
      let hasMatchWarning = false
      Logger.info(`[LibraryItemController] Refreshing metadata for item ${itemId}`)
      try {
        const matchResult = await Scanner.quickMatchLibraryItem(this, libraryItem, {
          overrideDetails: true
        })
        if (matchResult.updated) {
          Logger.info(`[LibraryItemController] Metadata updated for item ${itemId}`)
        } else if (matchResult.warning) {
          hasMatchWarning = true
          Logger.warn(`[LibraryItemController] Metadata match warning for item ${itemId}: ${matchResult.warning}`)
        }
      } catch (err) {
        Logger.warn(`[LibraryItemController] Failed to refresh metadata for item ${itemId}: ${err.message}`)
        // Continue anyway - use existing metadata
      }

      // If match failed, move to error directory
      if (hasMatchWarning) {
        try {
          const errorDirPath = Path.join(libraryFolder.path, '__Reorganize_Errors')
          await fs.ensureDir(errorDirPath)
          
          const errorPath = Path.join(errorDirPath, Path.basename(currentPath))
          Logger.warn(`[LibraryItemController] Moving unmatched item to error directory: ${currentPath} -> ${errorPath}`)
          await fs.move(currentPath, errorPath, { overwrite: false })
          
          // Update database
          await Database.libraryItemModel.update({ path: errorPath }, { where: { id: itemId } })
          Logger.info(`[LibraryItemController] Moved unmatched item ${itemId} to error directory`)
          
          return { success: true, warning: 'Item moved to error directory - no metadata match found' }
        } catch (err) {
          return { success: false, error: `Failed to move unmatched item to error directory: ${err.message}` }
        }
      }

      // Reload media with authors and series for books
      let media = libraryItem.media
      if (isBook) {
        media = await libraryItem.getMedia({
          include: [
            {
              model: Database.authorModel,
              through: {
                attributes: ['id', 'createdAt']
              }
            },
            {
              model: Database.seriesModel,
              through: {
                attributes: ['id', 'sequence', 'createdAt']
              }
            }
          ],
          order: [
            [Database.authorModel, Database.bookAuthorModel, 'createdAt', 'ASC'],
            [Database.seriesModel, 'bookSeries', 'createdAt', 'ASC']
          ]
        })
      }

      if (!media) {
        return { success: false, error: 'Media not found' }
      }

      // Build new path
      const parts = []
      if (isPodcast) {
        parts.push(media.title)
      } else if (isBook) {
        // Use only the first author
        if (media.authors && media.authors.length > 0) {
          parts.push(media.authors[0].name)
        }
        if (media.seriesName) {
          // Remove sequence number from series name (e.g., "Series Name #1" -> "Series Name")
          const seriesNameWithoutSequence = media.seriesName.replace(/\s*#\d+$/, '')
          parts.push(seriesNameWithoutSequence)
        }
        parts.push(media.title)
      }

      const sanitizedParts = parts.filter(Boolean).map((p) => sanitizeFilename(p))
      const newPath = Path.join(libraryFolder.path, ...sanitizedParts)

      Logger.info(`[LibraryItemController] Item path: ${currentPath} -> ${newPath}`)

      // Move files if path is different
      if (newPath !== currentPath) {
        // Check current directory exists
        const currentExists = await fs.pathExists(currentPath)
        if (!currentExists) {
          return { success: false, error: 'Current directory does not exist' }
        }

        // Check if target path has conflicts
        const targetExists = await fs.pathExists(newPath)
        if (targetExists) {
          // Check if this item already owns the target directory
          const existingItem = await Database.libraryItemModel.findOne({ where: { path: newPath } })
          if (existingItem) {
            if (existingItem.id === itemId) {
              // Item already reorganized to this location - skip
              Logger.info(`[LibraryItemController] Item ${itemId} already at target path, skipping`)
              return { success: true }
            } else {
              // Different item owns this directory - move it to error directory
              try {
                const errorDirPath = Path.join(libraryFolder.path, '__Reorganize_Errors')
                await fs.ensureDir(errorDirPath)
                
                const existingItemPath = existingItem.path
                const errorPath = Path.join(errorDirPath, Path.basename(existingItemPath))
                
                Logger.warn(`[LibraryItemController] Moving conflicting item to error directory: ${existingItemPath} -> ${errorPath}`)
                await fs.move(existingItemPath, errorPath, { overwrite: false })
                
                // Update the conflicting item's path in database
                await Database.libraryItemModel.update({ path: errorPath }, { where: { id: existingItem.id } })
                Logger.info(`[LibraryItemController] Moved conflicting item ${existingItem.id} to error directory`)
              } catch (err) {
                return { success: false, error: `Failed to move conflicting item: ${err.message}` }
              }
            }
          }

          // Target exists but isn't a registered item - check if it's empty
          try {
            const targetContents = await fs.readdir(newPath)
            if (targetContents.length > 0) {
              // Move conflicting directory to error directory
              try {
                const errorDirPath = Path.join(libraryFolder.path, '__Reorganize_Errors')
                await fs.ensureDir(errorDirPath)
                const errorPath = Path.join(errorDirPath, Path.basename(newPath) + '_conflict')
                Logger.warn(`[LibraryItemController] Moving conflicting directory to error: ${newPath} -> ${errorPath}`)
                await fs.move(newPath, errorPath, { overwrite: false })
                Logger.info(`[LibraryItemController] Moved conflicting directory to error path`)
              } catch (err) {
                return { success: false, error: `Cannot handle conflicting directory: ${err.message}` }
              }
            }
          } catch (err) {
            return { success: false, error: `Cannot access target directory: ${err.message}` }
          }
        }

        // Create target directory
        try {
          await fs.ensureDir(newPath)
        } catch (err) {
          return { success: false, error: `Cannot create target directory: ${err.message}` }
        }

        // Read and move files
        try {
          const files = await fs.readdir(currentPath)
          Logger.info(`[LibraryItemController] Moving ${files.length} files for item ${itemId}`)

          for (const file of files) {
            const src = Path.join(currentPath, file)
            const dst = Path.join(newPath, file)
            try {
              await fs.move(src, dst, { overwrite: true })
            } catch (err) {
              return { success: false, error: `Failed to move file ${file}: ${err.message}` }
            }
          }
        } catch (err) {
          return { success: false, error: `Failed to read source directory: ${err.message}` }
        }

        // Update database
        try {
          await Database.libraryItemModel.update({ path: newPath }, { where: { id: itemId } })
        } catch (err) {
          // Try to rollback files
          try {
            const movedFiles = await fs.readdir(newPath)
            for (const file of movedFiles) {
              const src = Path.join(newPath, file)
              const dst = Path.join(currentPath, file)
              await fs.move(src, dst, { overwrite: true })
            }
          } catch (rollbackErr) {
            Logger.error(`[LibraryItemController] Failed to rollback files: ${rollbackErr.message}`)
          }
          return { success: false, error: `Database update failed: ${err.message}` }
        }

        // Clean up old directory
        try {
          const remaining = await fs.readdir(currentPath)
          if (remaining.length === 0) {
            await fs.remove(currentPath)
            Logger.info(`[LibraryItemController] Removed empty old directory`)
          }
        } catch (err) {
          Logger.warn(`[LibraryItemController] Could not remove old directory: ${err.message}`)
        }
      } else {
        Logger.info(`[LibraryItemController] Paths are the same - no move needed for item ${itemId}`)
      }

      return { success: true }
    } catch (error) {
      Logger.error(`[LibraryItemController] Error reorganizing item: ${error.message}`)
      return { success: false, error: error.message }
    }
  }

  /**
   * POST: /api/items/batch/reorganize-files
   * Reorganize multiple library items' files into metadata-based directory structure
   * Responds immediately, processes in background
   *
   * @this {import('../routers/ApiRouter')}
   * @param {RequestWithUser} req - Request with libraryItemIds in body
   * @param {Response} res
   */
  async batchReorganizeFiles(req, res) {
    if (!req.user.canUpdate) {
      Logger.warn(`[LibraryItemController] User "${req.user.username}" attempted to batch reorganize without permission`)
      return res.sendStatus(403)
    }

    const { libraryItemIds } = req.body
    if (!libraryItemIds?.length || !Array.isArray(libraryItemIds)) {
      return res.status(400).send('Invalid request body')
    }

    // Fetch items
    const itemsToReorganize = await Database.libraryItemModel.findAllExpandedWhere({
      id: libraryItemIds
    })

    if (!itemsToReorganize.length) {
      return res.sendStatus(404)
    }

    // Respond immediately - this is a long-running operation
    res.sendStatus(200)

    // Get the controller instance for calling helper methods
    const controller = require('./LibraryItemController')

    // Process in background
    Logger.info(`[LibraryItemController] Starting batch reorganize for ${itemsToReorganize.length} items`)
    let successCount = 0
    let warningCount = 0
    let errorCount = 0
    const errors = []
    const warnings = []

    for (const libraryItem of itemsToReorganize) {
      // Get the controller instance to call helper methods
      const result = await controller.reorganizeFilesForItem(libraryItem)
      if (result.success) {
        if (result.warning) {
          warningCount++
          warnings.push({ id: libraryItem.id, title: libraryItem.media.title, warning: result.warning })
          Logger.warn(`[LibraryItemController] Reorganized with warning: ${libraryItem.media.title} - ${result.warning}`)
        } else {
          successCount++
          Logger.info(`[LibraryItemController] Successfully reorganized: ${libraryItem.media.title}`)
        }
      } else {
        errorCount++
        errors.push({ id: libraryItem.id, title: libraryItem.media.title, error: result.error })
        Logger.error(`[LibraryItemController] Failed to reorganize ${libraryItem.media.title}: ${result.error}`)
      }
    }

    Logger.info(`[LibraryItemController] Batch reorganize complete: ${successCount} succeeded, ${warningCount} moved to error dir, ${errorCount} failed`)

    // Notify user of completion
    SocketAuthority.clientEmitter(req.user.id, 'batch_reorganize_complete', {
      successCount,
      warningCount,
      errorCount,
      warnings,
      errors,
      total: itemsToReorganize.length
    })
  }



  async middleware(req, res, next) {
    req.libraryItem = await Database.libraryItemModel.getExpandedById(req.params.id)
    if (!req.libraryItem?.media) return res.sendStatus(404)

    // Check user can access this library item
    if (!req.user.checkCanAccessLibraryItem(req.libraryItem)) {
      return res.sendStatus(403)
    }

    // For library file routes, get the library file
    if (req.params.fileid) {
      req.libraryFile = req.libraryItem.getLibraryFileWithIno(req.params.fileid)
      if (!req.libraryFile) {
        Logger.error(`[LibraryItemController] Library file "${req.params.fileid}" does not exist for library item`)
        return res.sendStatus(404)
      }
    }

    if (req.path.includes('/play')) {
      // allow POST requests using /play and /play/:episodeId
    } else if (req.method == 'DELETE' && !req.user.canDelete) {
      Logger.warn(`[LibraryItemController] User "${req.user.username}" attempted to delete without permission`)
      return res.sendStatus(403)
    } else if ((req.method == 'PATCH' || req.method == 'POST') && !req.user.canUpdate) {
      Logger.warn(`[LibraryItemController] User "${req.user.username}" attempted to update without permission`)
      return res.sendStatus(403)
    }

    next()
  }
}
module.exports = new LibraryItemController()
