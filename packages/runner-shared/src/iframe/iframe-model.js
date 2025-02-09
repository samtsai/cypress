import _ from 'lodash'
import { action } from 'mobx'

import { selectorPlaygroundModel } from '../selector-playground'
import { studioRecorder } from '../studio'
import { eventManager } from '../event-manager'

export class IframeModel {
  constructor ({ state, detachDom, restoreDom, highlightEl, snapshotControls, isAUTSameOrigin, removeSrc }) {
    this.state = state
    this.detachDom = detachDom
    this.restoreDom = restoreDom
    this.highlightEl = highlightEl
    this.snapshotControls = snapshotControls
    this.isAUTSameOrigin = isAUTSameOrigin
    this.removeSrc = removeSrc

    this._reset()
  }

  listen () {
    eventManager.on('run:start', action('run:start', this._beforeRun))
    eventManager.on('run:end', action('run:end', this._afterRun))

    eventManager.on('viewport:changed', action('viewport:changed', this._updateViewport))
    eventManager.on('config', action('config', (config) => {
      this._updateViewport(_.map(config, 'viewportHeight', 'viewportWidth'))
    }))

    eventManager.on('url:changed', action('url:changed', this._updateUrl))
    eventManager.on('page:loading', action('page:loading', this._updateLoadingUrl))

    eventManager.on('show:snapshot', action('show:snapshot', this._setSnapshots))
    eventManager.on('hide:snapshot', action('hide:snapshot', this._clearSnapshots))

    eventManager.on('pin:snapshot', action('pin:snapshot', this._pinSnapshot))
    eventManager.on('unpin:snapshot', action('unpin:snapshot', this._unpinSnapshot))
  }

  _beforeRun = () => {
    this.state.isLoading = false
    this.state.isRunning = true
    this.state.resetUrl()
    selectorPlaygroundModel.setEnabled(false)
    this._reset()
    this._clearMessage()
  }

  _afterRun = () => {
    this.state.isRunning = false
  }

  _updateViewport = ({ viewportWidth, viewportHeight }, cb) => {
    this.state.updateDimensions(viewportWidth, viewportHeight)

    if (cb) {
      this.state.setCallbackAfterUpdate(cb)
    }
  }

  _updateUrl = (url) => {
    this.state.url = url
  }

  _updateLoadingUrl = (isLoadingUrl) => {
    this.state.isLoadingUrl = isLoadingUrl
  }

  _clearMessage = () => {
    this.state.clearMessage()
  }

  _setSnapshots = (snapshotProps) => {
    if (this.isSnapshotPinned) return

    if (this.state.isRunning) {
      return this._testsRunningError()
    }

    if (studioRecorder.isOpen) {
      return this._studioOpenError()
    }

    const { snapshots } = snapshotProps

    if (!snapshots || !snapshots.length) {
      this._clearSnapshots()
      this._setMissingSnapshotMessage()

      return
    }

    this.state.highlightUrl = true

    if (!this.originalState) {
      this._storeOriginalState()
    }

    this.detachedId = snapshotProps.id

    this._updateViewport(snapshotProps)
    this._updateUrl(snapshotProps.url)

    clearInterval(this.intervalId)

    const revert = action('revert:snapshot', this._showSnapshot)

    if (snapshots.length > 1) {
      let i = 0

      this.intervalId = setInterval(() => {
        if (this.isSnapshotPinned) return

        i += 1
        if (!snapshots[i]) {
          i = 0
        }

        revert(snapshots[i], snapshotProps)
      }, 800)
    }

    revert(snapshots[0], snapshotProps)
  }

  _showSnapshot = (snapshot, snapshotProps) => {
    this.state.messageTitle = 'DOM Snapshot'
    this.state.messageDescription = snapshot.name
    this.state.messageType = ''

    this._restoreDom(snapshot, snapshotProps)
  }

  _restoreDom (snapshot, snapshotProps) {
    this.restoreDom(snapshot)

    if (snapshotProps.$el) {
      this.highlightEl(snapshot, snapshotProps)
    }
  }

  _clearSnapshots = () => {
    if (this.isSnapshotPinned) return

    clearInterval(this.intervalId)

    this.state.highlightUrl = false

    if (!this.originalState || !this.originalState.body) {
      return this._clearMessage()
    }

    const previousDetachedId = this.detachedId

    // process on next tick so we don't restore the dom if we're
    // about to receive another 'show:snapshot' event, else that would
    // be a huge waste
    setTimeout(action('clear:snapshots:next:tick', () => {
      // we want to only restore the dom if we haven't received
      // another snapshot by the time this function runs
      if (previousDetachedId !== this.detachedId) return

      this._updateViewport(this.originalState)
      this._updateUrl(this.originalState.url)
      this.restoreDom(this.originalState.snapshot)
      this._clearMessage()

      this.originalState = null
      this.detachedId = null
    }))
  }

  _pinSnapshot = (snapshotProps) => {
    const { snapshots } = snapshotProps

    if (!snapshots || !snapshots.length) {
      eventManager.snapshotUnpinned()
      this._setMissingSnapshotMessage()

      return
    }

    clearInterval(this.intervalId)

    this.isSnapshotPinned = true

    this.state.snapshot.showingHighlights = true
    this.state.snapshot.stateIndex = 0

    this.state.messageTitle = 'DOM Snapshot'
    this.state.messageDescription = 'pinned'
    this.state.messageType = 'info'
    this.state.messageControls = this.snapshotControls(snapshotProps)

    this._restoreDom(snapshots[0], snapshotProps)
  }

  _setMissingSnapshotMessage () {
    this.state.messageTitle = 'The snapshot is missing. Displaying current state of the DOM.'
    this.state.messageDescription = ''
    this.state.messageType = 'warning'
  }

  _unpinSnapshot = () => {
    this.isSnapshotPinned = false
    this.state.messageTitle = 'DOM Snapshot'
    this.state.messageDescription = ''
    this.state.messageControls = null
  }

  _testsRunningError () {
    this.state.messageTitle = 'Cannot show Snapshot while tests are running'
    this.state.messageType = 'warning'
  }

  _studioOpenError () {
    this.state.messageTitle = 'Cannot show Snapshot while creating commands in Studio'
    this.state.messageType = 'warning'
  }

  _storeOriginalState () {
    if (!this.isAUTSameOrigin()) {
      const Cypress = eventManager.getCypress()

      /**
       * This only happens if the AUT ends in a cross origin state that the primary doesn't have access to.
       * In this case, the final snapshot request from the primary is sent out to the cross-origin spec bridges.
       * The spec bridge that matches the origin policy will take a snapshot and send it back to the primary for the runner to store in originalState.
       */
      Cypress.primaryOriginCommunicator.toAllSpecBridges('generate:final:snapshot', this.state.url)
      Cypress.primaryOriginCommunicator.once('final:snapshot:generated', (finalSnapshot) => {
        this.originalState = {
          body: finalSnapshot.body,
          htmlAttrs: finalSnapshot.htmlAttrs,
          snapshot: finalSnapshot,
          url: this.state.url,
          // TODO: use same attr for both runner and runner-ct states.
          // these refer to the same thing - the viewport dimensions.
          viewportWidth: this.state.width,
          viewportHeight: this.state.height,
        }
      })

      return
    }

    const finalSnapshot = this.detachDom()

    if (!finalSnapshot) return

    const { body, htmlAttrs } = finalSnapshot

    this.originalState = {
      body,
      htmlAttrs,
      snapshot: finalSnapshot,
      url: this.state.url,
      // TODO: use same attr for both runner and runner-ct states.
      // these refer to the same thing - the viewport dimensions.
      viewportWidth: this.state.width,
      viewportHeight: this.state.height,
    }
  }

  _reset () {
    this.detachedId = null
    this.intervalId = null
    this.originalState = null
    this.isSnapshotPinned = false
  }
}
