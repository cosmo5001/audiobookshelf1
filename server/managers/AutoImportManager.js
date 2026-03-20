const Path = require('path')
const Logger = require('../Logger')
const fs = require('../libs/fsExtra')
const fileUtils = require('../utils/fileUtils')
const { sanitizeFilename } = require('../utils/fileUtils')
const Watcher = require('../libs/watcher/watcher')
const AudioFileScanner = require('../scanner/AudioFileScanner')
const parseNameString = require('../utils/parsers/parseNameString')
const BookFinder = require('../finders/BookFinder')
const PodcastFinder = require('../finders/PodcastFinder')

class AutoImportManager {
  constructor() {
    /** @type {Map<string, Watcher>} */
    this.autoImportWatchers = new Map()
    /** @type {Map<string, NodeJS.Timeout>} */
    this.autoImportDebounceTimers = new Map()
  }

  /**
   * Calculate similarity between two strings (0-1, where 1 is identical)
   * @param {string} str1
   * @param {string} str2
   * @returns {number} Similarity score
   */
  calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0
    const s1 = str1.toLowerCase().trim()
    const s2 = str2.toLowerCase().trim()
    
    if (s1 === s2) return 1
    
    // Simple word overlap check - count how many words match
    const words1 = s1.split(/[\s\-_]+/).filter(w => w.length > 2)
    const words2 = s2.split(/[\s\-_]+/).filter(w => w.length > 2)
    
    if (words1.length === 0 || words2.length === 0) return 0
    
    const matches = words1.filter(w => words2.some(w2 => w2.includes(w) || w.includes(w2)))
    return matches.length / Math.max(words1.length, words2.length)
  }

  /**
   * Enrich metadata by searching the metadata provider
   * @param {object} metadata - Basic metadata with title and optionally author
   * @param {string} mediaType - 'book' or 'podcast'
   * @param {string} provider - Provider slug (e.g., 'google', 'audible', 'itunes')
   * @returns {Promise<object>} Enriched metadata
   */
  async enrichMetadata(metadata, mediaType, provider) {
    if (!metadata.title) return metadata

    try {
      // Add timeout to prevent hanging
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Metadata enrichment timeout')), 10000)
      )

      if (mediaType === 'book') {
        try {
          const searchPromise = BookFinder.search(null, provider, metadata.title, metadata.author)
          const results = await Promise.race([searchPromise, timeoutPromise])
          
          if (results && results.length > 0) {
            const topResult = results[0]
            
            // Validate that enriched result is a good match
            const titleSimilarity = this.calculateSimilarity(metadata.title, topResult.title)
            const authorMatch = !metadata.author || !topResult.author || this.calculateSimilarity(metadata.author, topResult.author) > 0.3
            
            if (titleSimilarity > 0.4 && authorMatch) {
              Logger.debug(`[AutoImportManager] Found enriched metadata for "${metadata.title}" from ${provider}`)
              return {
                title: topResult.title || metadata.title,
                author: topResult.author || metadata.author,
                series: topResult.series || metadata.series,
                subtitle: topResult.subtitle,
                description: topResult.description,
                cover: topResult.cover,
                publishYear: topResult.publishYear,
                isbn: topResult.isbn,
                asin: topResult.asin
              }
            } else {
              Logger.warn(`[AutoImportManager] Enriched metadata for "${metadata.title}" has poor similarity (title: ${(titleSimilarity * 100).toFixed(0)}%, author match: ${authorMatch}), using original metadata`)
            }
          }
        } catch (error) {
          Logger.warn(`[AutoImportManager] Book metadata search failed for "${metadata.title}": ${error.message}`)
        }
      } else if (mediaType === 'podcast') {
        try {
          const searchPromise = PodcastFinder.search(metadata.title)
          const results = await Promise.race([searchPromise, timeoutPromise])
          
          if (results && results.length > 0) {
            const topResult = results[0]
            const titleSimilarity = this.calculateSimilarity(metadata.title, topResult.title)
            
            if (titleSimilarity > 0.4) {
              Logger.debug(`[AutoImportManager] Found enriched metadata for podcast "${metadata.title}"`)
              return {
                title: topResult.title || metadata.title,
                description: topResult.description,
                author: topResult.author || metadata.author,
                cover: topResult.cover || topResult.image
              }
            } else {
              Logger.warn(`[AutoImportManager] Enriched metadata for podcast "${metadata.title}" has poor similarity (${(titleSimilarity * 100).toFixed(0)}%), using original metadata`)
            }
          }
        } catch (error) {
          Logger.warn(`[AutoImportManager] Podcast metadata search failed for "${metadata.title}": ${error.message}`)
        }
      }
    } catch (error) {
      Logger.warn(`[AutoImportManager] Error enriching metadata for "${metadata.title}": ${error.message}`)
    }

    return metadata
  }

  /**
   * Scan auto-import folders and organize files using the same logic as the upload function
   * @param {import('../models/Library')} library
   * @param {import('../scanner/LibraryScan')} libraryScan
   */
  async scanAutoImportFolders(library, libraryScan) {
    if (!library.autoImportFolders || !library.autoImportFolders.length) {
      Logger.debug(`[AutoImportManager] No auto-import folders for library "${library.name}"`)
      return
    }

    Logger.info(`[AutoImportManager] Scanning ${library.autoImportFolders.length} auto-import folder(s) for library "${library.name}"`)

    // Get the first library folder as destination
    if (!library.libraryFolders || !library.libraryFolders.length) {
      Logger.warn(`[AutoImportManager] Library "${library.name}" has no library folders to import into`)
      return
    }

    const primaryLibraryFolder = library.libraryFolders[0]
    let itemsOrganized = 0
    let itemsErrored = 0

    for (const autoImportFolder of library.autoImportFolders) {
      const folderPath = autoImportFolder.path
      
      if (!(await fs.pathExists(folderPath))) {
        Logger.warn(`[AutoImportManager] Auto-import folder does not exist: "${folderPath}"`)
        continue
      }

      try {
        const contents = await fs.readdir(folderPath)
        
        for (const item of contents) {
          const itemPath = Path.join(folderPath, item)
          const stat = await fs.stat(itemPath)

          // Skip hidden files/folders
          if (item.startsWith('.')) {
            continue
          }

          if (stat.isDirectory()) {
            // Check if directory contains subfolders (which is an error condition)
            const hasSubfolders = await this.directoryHasSubfolders(itemPath)
            if (hasSubfolders) {
              Logger.warn(`[AutoImportManager] Folder "${item}" contains subfolders, moving to error directory`)
              const errorPath = await this.moveToErrorDirectory(itemPath, item, folderPath, 'invalid-structure')
              if (errorPath) {
                Logger.info(`[AutoImportManager] Moved invalid folder "${item}" to error directory: "${errorPath}"`)
                itemsErrored++
              }
              continue
            }

            // Check if directory contains valid audio files
            const hasValidAudioFiles = await this.directoryHasValidAudioFiles(itemPath)
            if (!hasValidAudioFiles) {
              Logger.warn(`[AutoImportManager] Folder "${item}" contains no valid audio files, moving to error directory`)
              const errorPath = await this.moveToErrorDirectory(itemPath, item, folderPath, 'no-audio-files')
              if (errorPath) {
                Logger.info(`[AutoImportManager] Moved folder with no valid audio files "${item}" to error directory: "${errorPath}"`)
                itemsErrored++
              }
              continue
            }

            // For directories, extract metadata and organize
            const organizedPath = await this.organizeItemToLibrary(itemPath, item, primaryLibraryFolder, library.mediaType, library, folderPath)
            if (organizedPath) {
              Logger.info(`[AutoImportManager] Organized folder "${item}" to "${Path.relative(primaryLibraryFolder.path, organizedPath)}"`)
              itemsOrganized++
            }
          } else if (stat.isFile()) {
            // For single files, extract metadata and create appropriate folder structure
            const organizedPath = await this.organizeFileToLibrary(itemPath, item, primaryLibraryFolder, library.mediaType, library, folderPath)
            if (organizedPath) {
              Logger.info(`[AutoImportManager] Organized file "${item}" to "${Path.relative(primaryLibraryFolder.path, organizedPath)}"`)
              itemsOrganized++
            }
          }
        }
      } catch (error) {
        Logger.error(`[AutoImportManager] Error scanning auto-import folder "${folderPath}"`, error)
      }
    }

    if (itemsOrganized > 0) {
      Logger.info(`[AutoImportManager] Organized ${itemsOrganized} item(s) from auto-import folder(s) for library "${library.name}"`)
      if (libraryScan) {
        libraryScan.addLog(4, `Organized ${itemsOrganized} item(s) from auto-import folder(s)`)
      }
    }

    if (itemsErrored > 0) {
      Logger.warn(`[AutoImportManager] ${itemsErrored} item(s) had errors and were moved to error directory`)
      if (libraryScan) {
        libraryScan.addLog(2, `${itemsErrored} item(s) had errors and were moved to error directory`)
      }
    }
  }

  /**
   * Check if a directory contains any subfolders
   * @param {string} folderPath
   * @returns {Promise<boolean>} True if directory contains subfolders
   */
  async directoryHasSubfolders(folderPath) {
    try {
      const contents = await fs.readdir(folderPath)
      for (const item of contents) {
        if (item.startsWith('.')) continue
        const itemPath = Path.join(folderPath, item)
        const stat = await fs.stat(itemPath)
        if (stat.isDirectory()) {
          return true
        }
      }
      return false
    } catch (error) {
      Logger.debug(`[AutoImportManager] Error checking for subfolders in "${folderPath}"`)
      return false
    }
  }

  /**
   * Check if a directory contains any valid audio files
   * @param {string} folderPath
   * @returns {Promise<boolean>} True if directory contains valid audio files
   */
  async directoryHasValidAudioFiles(folderPath) {
    try {
      const validAudioExtensions = ['.m4b', '.m4a', '.mp3', '.flac', '.opus', '.ogg', '.wma', '.aac', '.alac', '.wav']
      const contents = await fs.readdir(folderPath)
      for (const item of contents) {
        if (item.startsWith('.')) continue
        const itemPath = Path.join(folderPath, item)
        const stat = await fs.stat(itemPath)
        if (stat.isFile()) {
          const ext = Path.extname(itemPath).toLowerCase()
          if (validAudioExtensions.includes(ext)) {
            return true
          }
        }
      }
      return false
    } catch (error) {
      Logger.debug(`[AutoImportManager] Error checking for audio files in "${folderPath}"`)
      return false
    }
  }

  /**
   * Move a folder to an error directory for manual review
   * @param {string} itemPath - Path to the folder with error
   * @param {string} itemName - Name of the folder
   * @param {string} importFolderPath - Path to the import folder
   * @param {string} [errorType] - Type of error (e.g., 'invalid-structure', 'no-audio-files', 'duplicate')
   * @returns {Promise<string|null>} Path to error directory or null if failed
   */
  async moveToErrorDirectory(itemPath, itemName, importFolderPath, errorType) {
    try {
      // Create error subdirectory in the import folder
      let errorDirPath = Path.join(importFolderPath, '.error')
      
      // Create type-specific subfolder if error type provided
      if (errorType) {
        errorDirPath = Path.join(errorDirPath, errorType)
      }
      
      await fs.ensureDir(errorDirPath)

      // Move item to error directory
      const errorItemPath = Path.join(errorDirPath, itemName)
      
      // If it already exists, append timestamp
      if (await fs.pathExists(errorItemPath)) {
        const timestamp = Date.now()
        const errorItemPathWithTime = Path.join(errorDirPath, `${itemName}_${timestamp}`)
        await fs.move(itemPath, errorItemPathWithTime, { overwrite: false })
        return errorItemPathWithTime
      }

      await fs.move(itemPath, errorItemPath, { overwrite: false })
      return errorItemPath
    } catch (error) {
      Logger.error(`[AutoImportManager] Failed to move folder to error directory: "${itemName}"`, error)
      return null
    }
  }

  /**
   * Organize a folder item to library using the same path structure as the upload function
   * @param {string} itemPath
   * @param {string} itemName
   * @param {import('../models/LibraryFolder')} libraryFolder
   * @param {string} mediaType
   * @param {import('../models/Library')} library
   * @param {string} [importFolderPath] - Path to import folder for moving duplicates to error
   * @returns {Promise<string|null>} Organized path or null if failed
   */
  async organizeItemToLibrary(itemPath, itemName, libraryFolder, mediaType, library, importFolderPath) {
    try {
      // Extract metadata from the folder
      let metadata = await this.extractMetadataFromFolder(itemPath, mediaType)
      Logger.info(`[AutoImportManager] Extracted metadata for "${itemName}": title="${metadata.title}", author="${metadata.author}"`)
      
      // Enrich metadata if enabled
      const settings = library.settings || {}
      Logger.debug(`[AutoImportManager] Library settings: autoImportEnrichMetadata=${settings.autoImportEnrichMetadata}`)
      if (settings.autoImportEnrichMetadata === true) {
        try {
          const provider = library.provider || (mediaType === 'book' ? 'google' : 'itunes')
          Logger.info(`[AutoImportManager] Enriching metadata for "${itemName}" using provider "${provider}"`)
          metadata = await this.enrichMetadata(metadata, mediaType, provider)
          Logger.info(`[AutoImportManager] Enriched metadata for "${itemName}": title="${metadata.title}", author="${metadata.author}"`)
        } catch (enrichError) {
          Logger.warn(`[AutoImportManager] Metadata enrichment failed for "${itemName}", using basic metadata: ${enrichError.message}`)
          // Continue with basic metadata if enrichment fails
        }
      }
      
      // Generate organized folder path using same logic as upload
      const organizedPath = this.generateOrganizedPath(libraryFolder.path, metadata, mediaType)
      
      // Check if destination already exists
      if (await fs.pathExists(organizedPath)) {
        Logger.warn(`[AutoImportManager] Destination already exists (duplicate): "${itemName}", moving to error folder`)
        if (importFolderPath) {
          await this.moveToErrorDirectory(itemPath, itemName, importFolderPath, 'duplicate')
        }
        return null
      }

      // Move folder to organized path
      await fs.move(itemPath, organizedPath)
      return organizedPath
    } catch (error) {
      Logger.error(`[AutoImportManager] Failed to organize folder "${itemName}"`, error)
      return null
    }
  }

  /**
   * Organize a file to library using the same path structure as the upload function
   * @param {string} filePath
   * @param {string} fileName
   * @param {import('../models/LibraryFolder')} libraryFolder
   * @param {string} mediaType
   * @param {import('../models/Library')} library
   * @param {string} [importFolderPath] - Path to import folder for moving duplicates to error
   * @returns {Promise<string|null>} Organized path or null if failed
   */
  async organizeFileToLibrary(filePath, fileName, libraryFolder, mediaType, library, importFolderPath) {
    try {
      // Extract metadata from file
      let metadata = await this.extractMetadataFromFile(filePath, mediaType)
      
      // Enrich metadata if enabled
      const settings = library.settings || {}
      if (settings.autoImportEnrichMetadata === true) {
        try {
          const provider = library.provider || (mediaType === 'book' ? 'google' : 'itunes')
          Logger.debug(`[AutoImportManager] Enriching metadata for "${fileName}" using provider "${provider}"`)
          metadata = await this.enrichMetadata(metadata, mediaType, provider)
        } catch (enrichError) {
          Logger.warn(`[AutoImportManager] Metadata enrichment failed for "${fileName}", using basic metadata: ${enrichError.message}`)
          // Continue with basic metadata if enrichment fails
        }
      }
      
      // Generate organized folder path using same logic as upload
      const organizedFolderPath = this.generateOrganizedPath(libraryFolder.path, metadata, mediaType)
      
      // Ensure folder exists
      await fs.ensureDir(organizedFolderPath)
      
      // Move file to organized folder
      const destPath = Path.join(organizedFolderPath, sanitizeFilename(fileName))
      
      if (await fs.pathExists(destPath)) {
        Logger.warn(`[AutoImportManager] File already exists at destination (duplicate): "${fileName}", moving to error folder`)
        if (importFolderPath) {
          await this.moveToErrorDirectory(filePath, fileName, importFolderPath, 'duplicate')
        }
        return null
      }

      await fs.move(filePath, destPath)
      return organizedFolderPath
    } catch (error) {
      Logger.error(`[AutoImportManager] Failed to organize file "${fileName}"`, error)
      return null
    }
  }

  /**
   * Extract metadata from a folder by analyzing its contents
   * Matches the upload function's metadata extraction approach
   * @param {string} folderPath
   * @param {string} mediaType
   * @returns {Promise<object>} Metadata object with title, author, series
   */
  async extractMetadataFromFolder(folderPath, mediaType) {
    const metadata = {
      title: null,
      author: null,
      series: null
    }

    try {
      const contents = await fs.readdir(folderPath)
      
      // Try to find and parse media files first
      for (const item of contents) {
        const fullPath = Path.join(folderPath, item)
        const stat = await fs.stat(fullPath)
        
        if (stat.isFile()) {
          const ext = Path.extname(item).toLowerCase()
          
          // For audio files, extract metadata
          if (['.m4b', '.m4a', '.mp3', '.flac', '.opus', '.ogg', '.wma', '.aac', '.alac', '.wav'].includes(ext)) {
            try {
              const fileMetadata = await this.extractMetadataFromFile(fullPath, mediaType)
              if (fileMetadata.title) metadata.title = fileMetadata.title
              if (fileMetadata.author) metadata.author = fileMetadata.author
              if (fileMetadata.series) metadata.series = fileMetadata.series
              if (metadata.title && metadata.author) break // Got what we need
            } catch (error) {
              Logger.debug(`[AutoImportManager] Could not extract metadata from ${item}`)
            }
          }
        }
      }
      
      // If still no title, parse folder name
      if (!metadata.title) {
        const folderName = Path.basename(folderPath)
        // Try to extract author and title from folder name using the same logic as filenames
        const parsed = this.parseFilename(folderName)
        metadata.title = parsed.title
        if (parsed.author && !metadata.author) {
          metadata.author = parsed.author
        }
      }
      
    } catch (error) {
      Logger.debug(`[AutoImportManager] Error extracting metadata from folder`, error.message)
      metadata.title = Path.basename(folderPath)
    }

    return metadata
  }

  /**
   * Extract metadata from a media file
   * Matches the upload function's metadata extraction from tags
   * @param {string} filePath
   * @param {string} mediaType
   * @returns {Promise<object>} Metadata object with title, author, series
   */
  async extractMetadataFromFile(filePath, mediaType) {
    const metadata = {
      title: null,
      author: null,
      series: null
    }

    try {
      const ext = Path.extname(filePath).toLowerCase()
      
      // For audio files, probe and extract metadata from tags
      if (['.m4b', '.m4a', '.mp3', '.flac', '.opus', '.ogg', '.wma', '.aac', '.alac', '.wav'].includes(ext)) {
        try {
          const probeData = await AudioFileScanner.probeAudioFile(filePath)
          
          if (probeData && probeData.format && probeData.format.tags) {
            const tags = probeData.format.tags
            
            // Extract title from tags (prefer 'title', then 'album')
            if (tags.title) {
              metadata.title = tags.title
            } else if (tags.album) {
              metadata.title = tags.album
            }
            
            // Clean up title if it contains chapter/track information
            // e.g., "1 - Sentinel: Chapter 1" -> "Sentinel"
            if (metadata.title) {
              const parsed = this.parseFilename(metadata.title)
              metadata.title = parsed.title
            }
            
            // Extract author/artist from tags
            // Try album_artist first (audiobook), then artist
            if (tags.album_artist) {
              const parsed = parseNameString.parse(tags.album_artist)
              metadata.author = parsed?.names?.[0] || tags.album_artist
            } else if (tags.artist) {
              const parsed = parseNameString.parse(tags.artist)
              metadata.author = parsed?.names?.[0] || tags.artist
            }
            
            // Extract series if available
            if (tags.series) {
              metadata.series = tags.series
            }
          }
        } catch (error) {
          Logger.debug(`[AutoImportManager] Could not probe audio file`)
        }
      }
      
      // Fallback: parse filename if no title extracted from tags
      if (!metadata.title) {
        const baseName = Path.basename(filePath, Path.extname(filePath))
        
        // Try to extract author and title from filename
        const parsed = this.parseFilename(baseName)
        metadata.title = parsed.title || baseName
        if (parsed.author && !metadata.author) {
          metadata.author = parsed.author
        }
      }
      
    } catch (error) {
      Logger.debug(`[AutoImportManager] Error extracting metadata from file`)
      metadata.title = Path.basename(filePath, Path.extname(filePath))
    }

    return metadata
  }

  /**
   * Parse filename to extract title and author information
   * Handles patterns like: "01 - Author - Title", "Title (Author)", "Title-01-Chapter 1", etc.
   * @param {string} filename
   * @returns {object} Parsed metadata with title and author
   */
  parseFilename(filename) {
    let cleanedName = filename
    
    // Remove leading track numbers like "01 - ", "01. ", etc.
    cleanedName = cleanedName.replace(/^\d+[\s\-_.]+/, '')
    
    // Handle pattern: "Title-Number-Chapter/Track info" (e.g., "Sentinel-01-Chapter 1")
    // Stop at the first dash/underscore followed by a number
    const seriesMatch = cleanedName.match(/^(.+?)[\s\-_]\d+[\s\-_]/)
    if (seriesMatch) {
      return {
        title: seriesMatch[1].trim()
      }
    }
    
    // Remove trailing chapter/track indicators with colons or dashes
    // e.g., ": Chapter 1", " - Chapter 1", " - Chap 5", " - Track 3", etc.
    cleanedName = cleanedName.replace(/[\s:-]*(?:Chapter|Chap|Chapter\s*Book|Ch|Track|Part)\s*\d+\s*$/i, '')
    
    // Remove trailing numbers like " - 01", " 01", etc. (but not if it's the only thing)
    if (cleanedName.length > 2) {
      cleanedName = cleanedName.replace(/\s*[-–—]?\s*\d+\s*$/, '')
    }
    
    // Try to parse common patterns like "Author - Title"
    const dashSplit = cleanedName.split(/\s*[-–—]\s*/)
    if (dashSplit.length >= 2) {
      const firstPart = dashSplit[0].trim()
      const restParts = dashSplit.slice(1).map(p => p.trim())
      const restJoined = restParts.join(' - ')
      
      // Heuristic to detect if this is "Author - Title" pattern
      const firstPartWords = firstPart.split(/\s+/)
      const restWords = restJoined.split(/\s+/)
      
      // Check if first part looks like an author name:
      // 1. Contains comma (Last, First format)
      // 2. Contains "and" (multiple authors)
      // 3. Exactly 2 words both capitalized (Firstname Lastname)
      // 4. Single word AND rest is multi-word AND rest doesn't contain initials
      const isNameLike = 
        firstPart.includes(',') || // "Smith, John"
        firstPart.includes(' and ') || // "Smith and Johnson"
        /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(firstPart) // Exactly "Firstname Lastname" (no initials)
      
      const isTitleWord = /^(The|A|An|And|Or|But)$/i.test(firstPart)
      
      // Single word could be author only if rest looks like a title (not author with initials)
      const hasInitialPattern = /[A-Z]\.[A-Z]\./.test(restJoined) // J.R.R. or similar
      const singleWordAuthor = firstPartWords.length === 1 && restWords.length > 2 && !hasInitialPattern
      
      if ((isNameLike || singleWordAuthor) && !isTitleWord) {
        return {
          author: firstPart,
          title: restJoined
        }
      }
    }
    
    // Try parentheses pattern "Title (Author)"
    const parenMatch = cleanedName.match(/^(.+?)\s*\(([^)]+)\)$/)
    if (parenMatch) {
      return {
        title: parenMatch[1].trim(),
        author: parenMatch[2].trim()
      }
    }
    
    // No pattern matched - use the cleaned name as title
    return {
      title: cleanedName.trim()
    }
  }

  /**
   * Generate organized path based on metadata using the same structure as the upload function
   * For Podcasts: [title]
   * For Books/Audiobooks: [author, series, title]
   * @param {string} libraryFolderPath
   * @param {object} metadata
   * @param {string} mediaType
   * @returns {string} Organized path
   */
  generateOrganizedPath(libraryFolderPath, metadata, mediaType) {
    let pathParts = []

    if (mediaType === 'podcast') {
      // Podcasts use single level: [title]
      pathParts = [metadata.title]
    } else {
      // Books/Audiobooks use multi-level: [author, series, title]
      pathParts = [metadata.author, metadata.series, metadata.title]
    }

    // Filter out null/undefined values and sanitize all parts
    const cleanedParts = pathParts
      .filter(Boolean)
      .map((part) => sanitizeFilename(part))
    
    // Build the full path
    return Path.join(libraryFolderPath, ...cleanedParts)
  }

  /**
   * Watch auto-import folders for changes and organize files as they appear
   * @param {import('../models/Library')} library
   */
  async watchAutoImportFolders(library) {
    if (!library.autoImportFolders || !library.autoImportFolders.length) {
      Logger.debug(`[AutoImportManager] No auto-import folders to watch for library "${library.name}"`)
      return
    }

    Logger.info(`[AutoImportManager] Setting up watchers for ${library.autoImportFolders.length} auto-import folder(s) in library "${library.name}"`)

    const folderPaths = library.autoImportFolders
      .map((f) => f.path)
      .filter((path) => {
        if (!path) {
          Logger.warn(`[AutoImportManager] Invalid auto-import folder path`)
          return false
        }
        return true
      })

    if (!folderPaths.length) {
      Logger.warn(`[AutoImportManager] No valid auto-import folder paths to watch for library "${library.name}"`)
      return
    }

    // Close existing watcher if any
    const existingWatcher = this.autoImportWatchers.get(library.id)
    if (existingWatcher) {
      Logger.debug(`[AutoImportManager] Closing existing watcher for library "${library.name}"`)
      try {
        existingWatcher.close()
      } catch (error) {
        Logger.debug(`[AutoImportManager] Error closing watcher`)
      }
      this.autoImportWatchers.delete(library.id)
    }

    try {
      const watcher = new Watcher(folderPaths, {
        ignored: /(^|[\/\\])\./,
        renameDetection: true,
        renameTimeout: 2000,
        recursive: true,
        ignoreInitial: true,
        persistent: true
      })

      watcher.on('add', (path) => {
        Logger.debug(`[AutoImportManager] File added detected: "${path}"`)
        this.onFileAdded(library, path)
      })
      
      watcher.on('addDir', (path) => {
        Logger.debug(`[AutoImportManager] Directory added detected: "${path}"`)
        this.onFileAdded(library, path)
      })

      watcher.on('error', (error) => {
        Logger.error(`[AutoImportManager] Watcher error for library "${library.name}"`, error)
      })

      this.autoImportWatchers.set(library.id, watcher)
      Logger.info(`[AutoImportManager] Watcher set up for auto-import folders in library "${library.name}"`)
    } catch (error) {
      Logger.error(`[AutoImportManager] Failed to set up watcher for auto-import folders in library "${library.name}"`, error)
    }
  }

  /**
   * Handle file added to auto-import folder
   * @param {import('../models/Library')} library
   * @param {string} filePath
   */
  async onFileAdded(library, filePath) {
    Logger.info(`[AutoImportManager] New item added to auto-import folder: "${filePath}"`)
    
    // Clear existing debounce timer for this library if any
    const existingTimer = this.autoImportDebounceTimers.get(library.id)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }
    
    // Set a new debounce timer for 30 seconds
    const timer = setTimeout(() => {
      try {
        this.scanAutoImportFolders(library, null)
      } catch (error) {
        Logger.error(`[AutoImportManager] Error scanning auto-import folders`, error)
      }
    }, 30000)
    
    this.autoImportDebounceTimers.set(library.id, timer)
  }

  /**
   * Close all auto-import folder watchers
   */
  closeAllWatchers() {
    for (const [libraryId, watcher] of this.autoImportWatchers.entries()) {
      Logger.debug(`[AutoImportManager] Closing watcher for library "${libraryId}"`)
      try {
        watcher.close()
      } catch (error) {
        Logger.debug(`[AutoImportManager] Error closing watcher`)
      }
    }
    this.autoImportWatchers.clear()
    
    // Clear all debounce timers
    for (const [libraryId, timer] of this.autoImportDebounceTimers.entries()) {
      clearTimeout(timer)
    }
    this.autoImportDebounceTimers.clear()
  }

  /**
   * Close watcher for a specific library
   * @param {string} libraryId
   */
  closeWatcherForLibrary(libraryId) {
    const watcher = this.autoImportWatchers.get(libraryId)
    if (watcher) {
      Logger.debug(`[AutoImportManager] Closing watcher for library "${libraryId}"`)
      try {
        watcher.close()
      } catch (error) {
        Logger.debug(`[AutoImportManager] Error closing watcher`)
      }
      this.autoImportWatchers.delete(libraryId)
    }
    
    // Clear debounce timer for this library
    const timer = this.autoImportDebounceTimers.get(libraryId)
    if (timer) {
      clearTimeout(timer)
      this.autoImportDebounceTimers.delete(libraryId)
    }
  }
}

module.exports = new AutoImportManager()
