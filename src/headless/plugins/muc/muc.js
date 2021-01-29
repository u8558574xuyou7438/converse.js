import log from '../../log';
import muc_utils from './utils.js';
import p from '../../utils/parse-helpers';
import sizzle from 'sizzle';
import u from '../../utils/form';
import { Model } from '@converse/skeletor/src/model.js';
import { Strophe, $build, $iq, $msg, $pres } from 'strophe.js/src/strophe';
import { _converse, api, converse } from '../../core.js';
import { debounce, intersection, invoke, isElement, pick, zipObject } from 'lodash-es';
import { isArchived } from '@converse/headless/shared/parsers';
import { parseMemberListIQ, parseMUCMessage, parseMUCPresence } from './parsers.js';
import { sendMarker } from '@converse/headless/shared/actions';

const ACTION_INFO_CODES = ['301', '303', '333', '307', '321', '322'];

const MUCSession = Model.extend({
    defaults () {
        return {
            'connection_status': converse.ROOMSTATUS.DISCONNECTED
        };
    }
});

/**
 * Represents an open/ongoing groupchat conversation.
 * @mixin
 * @namespace _converse.ChatRoom
 * @memberOf _converse
 */
const ChatRoomMixin = {
    defaults () {
        return {
            'bookmarked': false,
            'chat_state': undefined,
            'has_activity': false, // XEP-437
            'hidden': _converse.isUniView() && !api.settings.get('singleton'),
            'hidden_occupants': !!api.settings.get('hide_muc_participants'),
            'message_type': 'groupchat',
            'name': '',
            // For group chats, we distinguish between generally unread
            // messages and those ones that specifically mention the
            // user.
            //
            // To keep things simple, we reuse `num_unread` from
            // _converse.ChatBox to indicate unread messages which
            // mention the user and `num_unread_general` to indicate
            // generally unread messages (which *includes* mentions!).
            'num_unread_general': 0,
            'num_unread': 0,
            'roomconfig': {},
            'time_opened': this.get('time_opened') || new Date().getTime(),
            'time_sent': new Date(0).toISOString(),
            'type': _converse.CHATROOMS_TYPE
        };
    },

    async initialize () {
        this.initialized = u.getResolveablePromise();
        this.debouncedRejoin = debounce(this.rejoin, 250);
        this.set('box_id', `box-${this.get('jid')}`);
        this.initNotifications();
        this.initMessages();
        this.initOccupants();
        this.initDiscoModels(); // sendChatState depends on this.features
        this.registerHandlers();

        this.on('change:chat_state', this.sendChatState, this);
        this.on('change:hidden', this.onHiddenChange, this);
        this.on('destroy', this.removeHandlers, this);

        await this.restoreSession();
        this.session.on('change:connection_status', this.onConnectionStatusChanged, this);

        this.listenTo(this.occupants, 'add', this.onOccupantAdded);
        this.listenTo(this.occupants, 'remove', this.onOccupantRemoved);
        this.listenTo(this.occupants, 'change:show', this.onOccupantShowChanged);
        this.listenTo(this.occupants, 'change:affiliation', this.createAffiliationChangeMessage);
        this.listenTo(this.occupants, 'change:role', this.createRoleChangeMessage);

        const restored = await this.restoreFromCache();
        if (!restored) {
            this.join();
        }
        /**
         * Triggered once a {@link _converse.ChatRoom} has been created and initialized.
         * @event _converse#chatRoomInitialized
         * @type { _converse.ChatRoom }
         * @example _converse.api.listen.on('chatRoomInitialized', model => { ... });
         */
        await api.trigger('chatRoomInitialized', this, { 'Synchronous': true });
        this.initialized.resolve();
    },

    /**
     * Checks whether we're still joined and if so, restores the MUC state from cache.
     * @private
     * @method _converse.ChatRoom#restoreFromCache
     * @returns { Boolean } Returns `true` if we're still joined, otherwise returns `false`.
     */
    async restoreFromCache () {
        if (this.session.get('connection_status') === converse.ROOMSTATUS.ENTERED && (await this.isJoined())) {
            // We've restored the room from cache and we're still joined.
            await new Promise(resolve => this.features.fetch({ 'success': resolve, 'error': resolve }));
            await this.fetchOccupants().catch(e => log.error(e));
            await this.fetchMessages().catch(e => log.error(e));
            return true;
        } else {
            this.clearCache();
            return false;
        }
    },

    /**
     * Join the MUC
     * @private
     * @method _converse.ChatRoom#join
     * @param { String } nick - The user's nickname
     * @param { String } [password] - Optional password, if required by the groupchat.
     *  Will fall back to the `password` value stored in the room
     *  model (if available).
     */
    async join (nick, password) {
        if (this.session.get('connection_status') === converse.ROOMSTATUS.ENTERED) {
            // We have restored a groupchat from session storage,
            // so we don't send out a presence stanza again.
            return this;
        }

        // Set this early, so we don't rejoin in onHiddenChange
        this.session.save('connection_status', converse.ROOMSTATUS.CONNECTING);
        await this.refreshDiscoInfo();
        nick = await this.getAndPersistNickname(nick);
        if (!nick) {
            u.safeSave(this.session, { 'connection_status': converse.ROOMSTATUS.NICKNAME_REQUIRED });
            if (api.settings.get('muc_show_logs_before_join')) {
                await this.fetchMessages();
            }
            return this;
        }
        const stanza = $pres({
            'from': _converse.connection.jid,
            'to': this.getRoomJIDAndNick()
        })
            .c('x', { 'xmlns': Strophe.NS.MUC })
            .c('history', {
                'maxstanzas': this.features.get('mam_enabled') ? 0 : api.settings.get('muc_history_max_stanzas')
            })
            .up();

        password = password || this.get('password');
        if (password) {
            stanza.cnode(Strophe.xmlElement('password', [], password));
        }
        api.send(stanza);
        return this;
    },

    /**
     * Clear stale cache and re-join a MUC we've been in before.
     * @private
     * @method _converse.ChatRoom#rejoin
     */
    rejoin () {
        this.registerHandlers();
        this.clearCache();
        return this.join();
    },

    clearCache () {
        this.session.save('connection_status', converse.ROOMSTATUS.DISCONNECTED);
        if (this.occupants.length) {
            // Remove non-members when reconnecting
            this.occupants.filter(o => !o.isMember()).forEach(o => o.destroy());
        } else {
            // Looks like we haven't restored occupants from cache, so we clear it.
            this.occupants.clearStore();
        }
    },

    /**
     * Given the passed in MUC message, send a XEP-0333 chat marker.
     * @param { _converse.MUCMessage } msg
     * @param { ('received'|'displayed'|'acknowledged') } [type='displayed']
     * @param { Boolean } force - Whether a marker should be sent for the
     *  message, even if it didn't include a `markable` element.
     */
    sendMarkerForMessage (msg, type = 'displayed', force = false) {
        if (!msg || !api.settings.get('send_chat_markers').includes(type)) {
            return;
        }
        if (msg?.get('is_markable') || force) {
            const key = `stanza_id ${this.get('jid')}`;
            const id = msg.get(key);
            if (!id) {
                log.error(`Can't send marker for message without stanza ID: ${key}`);
                return;
            }
            const from_jid = Strophe.getBareJidFromJid(msg.get('from'));
            sendMarker(from_jid, id, type, msg.get('type'));
        }
    },

    /**
     * Ensures that the user is subscribed to XEP-0437 Room Activity Indicators
     * if `muc_subscribe_to_rai` is set to `true`.
     * Only affiliated users can subscribe to RAI, but this method doesn't
     * check whether the current user is affiliated because it's intended to be
     * called after the MUC has been left and we don't have that information
     * anymore.
     * @private
     * @method _converse.ChatRoom#enableRAI
     */
    enableRAI () {
        if (api.settings.get('muc_subscribe_to_rai')) {
            const muc_domain = Strophe.getDomainFromJid(this.get('jid'));
            api.user.presence.send(null, muc_domain, null, $build('rai', { 'xmlns': Strophe.NS.RAI }));
        }
    },

    /**
     * Handler that gets called when the 'hidden' flag is toggled.
     * @private
     * @method _converse.ChatRoom#onHiddenChange
     */
    async onHiddenChange () {
        const conn_status = this.session.get('connection_status');
        if (this.get('hidden') && conn_status === converse.ROOMSTATUS.ENTERED) {
            if (api.settings.get('muc_subscribe_to_rai') && this.getOwnAffiliation() !== 'none') {
                if (conn_status !== converse.ROOMSTATUS.DISCONNECTED) {
                    this.sendMarkerForLastMessage('received', true);
                    await this.leave();
                }
                this.enableRAI();
            }
        } else if (conn_status === converse.ROOMSTATUS.DISCONNECTED) {
            this.rejoin();
        }
    },

    onOccupantAdded (occupant) {
        if (
            _converse.isInfoVisible(converse.MUC_TRAFFIC_STATES.ENTERED) &&
            this.session.get('connection_status') === converse.ROOMSTATUS.ENTERED &&
            occupant.get('show') === 'online'
        ) {
            this.updateNotifications(occupant.get('nick'), converse.MUC_TRAFFIC_STATES.ENTERED);
        }
    },

    onOccupantRemoved (occupant) {
        if (
            _converse.isInfoVisible(converse.MUC_TRAFFIC_STATES.EXITED) &&
            this.session.get('connection_status') === converse.ROOMSTATUS.ENTERED &&
            occupant.get('show') === 'online'
        ) {
            this.updateNotifications(occupant.get('nick'), converse.MUC_TRAFFIC_STATES.EXITED);
        }
    },

    onOccupantShowChanged (occupant) {
        if (occupant.get('states').includes('303')) {
            return;
        }
        if (occupant.get('show') === 'offline' && _converse.isInfoVisible(converse.MUC_TRAFFIC_STATES.EXITED)) {
            this.updateNotifications(occupant.get('nick'), converse.MUC_TRAFFIC_STATES.EXITED);
        } else if (occupant.get('show') === 'online' && _converse.isInfoVisible(converse.MUC_TRAFFIC_STATES.ENTERED)) {
            this.updateNotifications(occupant.get('nick'), converse.MUC_TRAFFIC_STATES.ENTERED);
        }
    },

    async onRoomEntered () {
        await this.occupants.fetchMembers();
        if (api.settings.get('clear_messages_on_reconnection')) {
            // Don't call this.clearMessages because we don't want to
            // recreate promises, since that will cause some existing
            // awaiters to never proceed.
            await this.messages.clearStore();
            // A bit hacky. No need to fetch messages after clearing
            this.messages.fetched.resolve();
        } else {
            await this.fetchMessages();
        }
        /**
         * Triggered when the user has entered a new MUC
         * @event _converse#enteredNewRoom
         * @type { _converse.ChatRoom}
         * @example _converse.api.listen.on('enteredNewRoom', model => { ... });
         */
        api.trigger('enteredNewRoom', this);
        if (
            api.settings.get('auto_register_muc_nickname') &&
            (await api.disco.supports(Strophe.NS.MUC_REGISTER, this.get('jid')))
        ) {
            this.registerNickname();
        }
    },

    async onConnectionStatusChanged () {
        if (this.session.get('connection_status') === converse.ROOMSTATUS.ENTERED) {
            if (this.get('hidden') && api.settings.get('muc_subscribe_to_rai') && this.getOwnAffiliation() !== 'none') {
                await this.leave();
                this.enableRAI();
            } else {
                await this.onRoomEntered();
            }
        }
    },

    async onReconnection () {
        await this.rejoin();
        this.announceReconnection();
    },

    getMessagesCollection () {
        return new _converse.ChatRoomMessages();
    },

    restoreSession () {
        const id = `muc.session-${_converse.bare_jid}-${this.get('jid')}`;
        this.session = new MUCSession({ id });
        this.session.browserStorage = _converse.createStore(id, 'session');
        return new Promise(r => this.session.fetch({ 'success': r, 'error': r }));
    },

    initDiscoModels () {
        let id = `converse.muc-features-${_converse.bare_jid}-${this.get('jid')}`;
        this.features = new Model(
            Object.assign(
                { id },
                zipObject(
                    converse.ROOM_FEATURES,
                    converse.ROOM_FEATURES.map(() => false)
                )
            )
        );
        this.features.browserStorage = _converse.createStore(id, 'session');

        id = `converse.muc-config-{_converse.bare_jid}-${this.get('jid')}`;
        this.config = new Model();
        this.config.browserStorage = _converse.createStore(id, 'session');
    },

    initOccupants () {
        this.occupants = new _converse.ChatRoomOccupants();
        const id = `converse.occupants-${_converse.bare_jid}${this.get('jid')}`;
        this.occupants.browserStorage = _converse.createStore(id, 'session');
        this.occupants.chatroom = this;
    },

    fetchOccupants () {
        this.occupants.fetched = new Promise(resolve => {
            this.occupants.fetch({
                'add': true,
                'silent': true,
                'success': resolve,
                'error': resolve
            });
        });
        return this.occupants.fetched;
    },

    handleAffiliationChangedMessage (stanza) {
        const item = sizzle(`x[xmlns="${Strophe.NS.MUC_USER}"] item`, stanza).pop();
        if (item) {
            const from = stanza.getAttribute('from');
            const type = stanza.getAttribute('type');
            const affiliation = item.getAttribute('affiliation');
            const jid = item.getAttribute('jid');
            const data = {
                from,
                type,
                affiliation,
                'nick': Strophe.getNodeFromJid(jid),
                'states': [],
                'show': type == 'unavailable' ? 'offline' : 'online',
                'role': item.getAttribute('role'),
                'jid': Strophe.getBareJidFromJid(jid),
                'resource': Strophe.getResourceFromJid(jid)
            };
            const occupant = this.occupants.findOccupant({ 'jid': data.jid });
            if (occupant) {
                occupant.save(data);
            } else {
                this.occupants.create(data);
            }
        }
    },

    async handleErrorMessageStanza (stanza) {
        const { __ } = _converse;
        const attrs = await parseMUCMessage(stanza, this, _converse);
        if (!(await this.shouldShowErrorMessage(attrs))) {
            return;
        }
        const message = this.getMessageReferencedByError(attrs);
        if (message) {
            const new_attrs = {
                'error': attrs.error,
                'error_condition': attrs.error_condition,
                'error_text': attrs.error_text,
                'error_type': attrs.error_type,
                'editable': false
            };
            if (attrs.msgid === message.get('retraction_id')) {
                // The error message refers to a retraction
                new_attrs.retraction_id = undefined;
                if (!attrs.error) {
                    if (attrs.error_condition === 'forbidden') {
                        new_attrs.error = __("You're not allowed to retract your message.");
                    } else if (attrs.error_condition === 'not-acceptable') {
                        new_attrs.error = __(
                            "Your retraction was not delivered because you're not present in the groupchat."
                        );
                    } else {
                        new_attrs.error = __('Sorry, an error occurred while trying to retract your message.');
                    }
                }
            } else if (!attrs.error) {
                if (attrs.error_condition === 'forbidden') {
                    new_attrs.error = __("Your message was not delivered because you weren't allowed to send it.");
                } else if (attrs.error_condition === 'not-acceptable') {
                    new_attrs.error = __("Your message was not delivered because you're not present in the groupchat.");
                } else {
                    new_attrs.error = __('Sorry, an error occurred while trying to send your message.');
                }
            }
            message.save(new_attrs);
        } else {
            this.createMessage(attrs);
        }
    },

    /**
     * Handles incoming message stanzas from the service that hosts this MUC
     * @private
     * @method _converse.ChatRoom#handleMessageFromMUCHost
     * @param { XMLElement } stanza
     */
    handleMessageFromMUCHost (stanza) {
        const conn_status = this.session.get('connection_status');
        if (conn_status === converse.ROOMSTATUS.ENTERED) {
            // We're not interested in activity indicators when already joined to the room
            return;
        }
        const rai = sizzle(`rai[xmlns="${Strophe.NS.RAI}"]`, stanza).pop();
        const active_mucs = Array.from(rai?.querySelectorAll('activity') || []).map(m => m.textContent);
        if (active_mucs.includes(this.get('jid'))) {
            this.save({
                'has_activity': true,
                'num_unread_general': 0 // Either/or between activity and unreads
            });
        }
    },

    handleForwardedMentions (stanza) {
        if (this.session.get('connection_status') === converse.ROOMSTATUS.ENTERED) {
            // Avoid counting mentions twice
            return;
        }
        const msgs = sizzle(
            `mentions[xmlns="${Strophe.NS.MENTIONS}"] forwarded[xmlns="${Strophe.NS.FORWARD}"] message[type="groupchat"]`,
            stanza
        );
        const muc_jid = this.get('jid');
        const mentions = msgs.filter(m => Strophe.getBareJidFromJid(m.getAttribute('from')) === muc_jid);
        if (mentions.length) {
            this.save({
                'has_activity': true,
                'num_unread': this.get('num_unread') + mentions.length
            });
            mentions.forEach(async stanza => {
                const attrs = await parseMUCMessage(stanza, this, _converse);
                const data = { stanza, attrs, 'chatbox': this };
                api.trigger('message', data);
            });
        }
    },

    /**
     * Parses an incoming message stanza and queues it for processing.
     * @private
     * @method _converse.ChatRoom#handleMessageStanza
     * @param { XMLElement } stanza
     */
    async handleMessageStanza (stanza) {
        if (stanza.getAttribute('type') !== 'groupchat') {
            this.handleForwardedMentions(stanza);
            return;
        }

        if (isArchived(stanza)) {
            // MAM messages are handled in converse-mam.
            // We shouldn't get MAM messages here because
            // they shouldn't have a `type` attribute.
            return log.warn(`Received a MAM message with type "groupchat"`);
        }
        this.createInfoMessages(stanza);
        this.fetchFeaturesIfConfigurationChanged(stanza);

        /**
         * @typedef { Object } MUCMessageData
         * An object containing the original groupchat message stanza,
         * as well as the parsed attributes.
         * @property { XMLElement } stanza
         * @property { MUCMessageAttributes } attrs
         * @property { ChatRoom } chatbox
         */
        const attrs = await parseMUCMessage(stanza, this, _converse);
        const data = { stanza, attrs, 'chatbox': this };
        /**
         * Triggered when a groupchat message stanza has been received and parsed.
         * @event _converse#message
         * @type { object }
         * @property { module:converse-muc~MUCMessageData } data
         */
        api.trigger('message', data);
        return attrs && this.queueMessage(attrs);
    },

    /**
     * Register presence and message handlers relevant to this groupchat
     * @private
     * @method _converse.ChatRoom#registerHandlers
     */
    registerHandlers () {
        const muc_jid = this.get('jid');
        const muc_domain = Strophe.getDomainFromJid(muc_jid);
        this.removeHandlers();
        this.presence_handler = _converse.connection.addHandler(
            stanza => this.onPresence(stanza) || true,
            null,
            'presence',
            null,
            null,
            muc_jid,
            { 'ignoreNamespaceFragment': true, 'matchBareFromJid': true }
        );

        this.domain_presence_handler = _converse.connection.addHandler(
            stanza => this.onPresenceFromMUCHost(stanza) || true,
            null,
            'presence',
            null,
            null,
            muc_domain
        );

        this.message_handler = _converse.connection.addHandler(
            stanza => !!this.handleMessageStanza(stanza) || true,
            null,
            'message',
            null,
            null,
            muc_jid,
            { 'matchBareFromJid': true }
        );

        this.domain_message_handler = _converse.connection.addHandler(
            stanza => this.handleMessageFromMUCHost(stanza) || true,
            null,
            'message',
            null,
            null,
            muc_domain
        );

        this.affiliation_message_handler = _converse.connection.addHandler(
            stanza => this.handleAffiliationChangedMessage(stanza) || true,
            Strophe.NS.MUC_USER,
            'message',
            null,
            null,
            muc_jid
        );
    },

    removeHandlers () {
        // Remove the presence and message handlers that were
        // registered for this groupchat.
        if (this.message_handler) {
            _converse.connection && _converse.connection.deleteHandler(this.message_handler);
            delete this.message_handler;
        }
        if (this.domain_message_handler) {
            _converse.connection && _converse.connection.deleteHandler(this.domain_message_handler);
            delete this.domain_message_handler;
        }
        if (this.presence_handler) {
            _converse.connection && _converse.connection.deleteHandler(this.presence_handler);
            delete this.presence_handler;
        }
        if (this.domain_presence_handler) {
            _converse.connection && _converse.connection.deleteHandler(this.domain_presence_handler);
            delete this.domain_presence_handler;
        }
        if (this.affiliation_message_handler) {
            _converse.connection && _converse.connection.deleteHandler(this.affiliation_message_handler);
            delete this.affiliation_message_handler;
        }
        return this;
    },

    invitesAllowed () {
        return (
            api.settings.get('allow_muc_invitations') &&
            (this.features.get('open') || this.getOwnAffiliation() === 'owner')
        );
    },

    getDisplayName () {
        const name = this.get('name');
        if (name) {
            return name;
        } else if (api.settings.get('locked_muc_domain') === 'hidden') {
            return Strophe.getNodeFromJid(this.get('jid'));
        } else {
            return this.get('jid');
        }
    },

    /**
     * Sends a message stanza to the XMPP server and expects a reflection
     * or error message within a specific timeout period.
     * @private
     * @method _converse.ChatRoom#sendTimedMessage
     * @param { _converse.Message|XMLElement } message
     * @returns { Promise<XMLElement>|Promise<_converse.TimeoutError> } Returns a promise
     *  which resolves with the reflected message stanza or rejects
     *  with an error stanza or with a {@link _converse.TimeoutError}.
     */
    sendTimedMessage (el) {
        if (typeof el.tree === 'function') {
            el = el.tree();
        }
        let id = el.getAttribute('id');
        if (!id) {
            // inject id if not found
            id = this.getUniqueId('sendIQ');
            el.setAttribute('id', id);
        }
        const promise = u.getResolveablePromise();
        const timeoutHandler = _converse.connection.addTimedHandler(_converse.STANZA_TIMEOUT, () => {
            _converse.connection.deleteHandler(handler);
            promise.reject(new _converse.TimeoutError('Timeout Error: No response from server'));
            return false;
        });
        const handler = _converse.connection.addHandler(
            stanza => {
                timeoutHandler && _converse.connection.deleteTimedHandler(timeoutHandler);
                if (stanza.getAttribute('type') === 'groupchat') {
                    promise.resolve(stanza);
                } else {
                    promise.reject(stanza);
                }
            },
            null,
            'message',
            ['error', 'groupchat'],
            id
        );
        api.send(el);
        return promise;
    },

    /**
     * Retract one of your messages in this groupchat
     * @private
     * @method _converse.ChatRoom#retractOwnMessage
     * @param { _converse.Message } message - The message which we're retracting.
     */
    async retractOwnMessage (message) {
        const __ = _converse.__;
        const origin_id = message.get('origin_id');
        if (!origin_id) {
            throw new Error("Can't retract message without a XEP-0359 Origin ID");
        }
        const editable = message.get('editable');
        const stanza = $msg({
            'id': u.getUniqueId(),
            'to': this.get('jid'),
            'type': 'groupchat'
        })
            .c('store', { xmlns: Strophe.NS.HINTS })
            .up()
            .c('apply-to', {
                'id': origin_id,
                'xmlns': Strophe.NS.FASTEN
            })
            .c('retract', { xmlns: Strophe.NS.RETRACT });

        // Optimistic save
        message.set({
            'retracted': new Date().toISOString(),
            'retracted_id': origin_id,
            'retraction_id': stanza.nodeTree.getAttribute('id'),
            'editable': false
        });
        try {
            await this.sendTimedMessage(stanza);
        } catch (e) {
            message.save({
                editable,
                'error_type': 'timeout',
                'error': __('A timeout happened while while trying to retract your message.'),
                'retracted': undefined,
                'retracted_id': undefined
            });
            throw e;
        }
    },

    /**
     * Retract someone else's message in this groupchat.
     * @private
     * @method _converse.ChatRoom#retractOtherMessage
     * @param { _converse.Message } message - The message which we're retracting.
     * @param { string } [reason] - The reason for retracting the message.
     */
    async retractOtherMessage (message, reason) {
        const editable = message.get('editable');
        // Optimistic save
        message.save({
            'moderated': 'retracted',
            'moderated_by': _converse.bare_jid,
            'moderated_id': message.get('msgid'),
            'moderation_reason': reason,
            'editable': false
        });
        const result = await this.sendRetractionIQ(message, reason);
        if (result === null || u.isErrorStanza(result)) {
            // Undo the save if something went wrong
            message.save({
                editable,
                'moderated': undefined,
                'moderated_by': undefined,
                'moderated_id': undefined,
                'moderation_reason': undefined
            });
        }
        return result;
    },

    /**
     * Sends an IQ stanza to the XMPP server to retract a message in this groupchat.
     * @private
     * @method _converse.ChatRoom#sendRetractionIQ
     * @param { _converse.Message } message - The message which we're retracting.
     * @param { string } [reason] - The reason for retracting the message.
     */
    sendRetractionIQ (message, reason) {
        const iq = $iq({ 'to': this.get('jid'), 'type': 'set' })
            .c('apply-to', {
                'id': message.get(`stanza_id ${this.get('jid')}`),
                'xmlns': Strophe.NS.FASTEN
            })
            .c('moderate', { xmlns: Strophe.NS.MODERATE })
            .c('retract', { xmlns: Strophe.NS.RETRACT })
            .up()
            .c('reason')
            .t(reason || '');
        return api.sendIQ(iq, null, false);
    },

    /**
     * Sends an IQ stanza to the XMPP server to destroy this groupchat. Not
     * to be confused with the {@link _converse.ChatRoom#destroy}
     * method, which simply removes the room from the local browser storage cache.
     * @private
     * @method _converse.ChatRoom#sendDestroyIQ
     * @param { string } [reason] - The reason for destroying the groupchat.
     * @param { string } [new_jid] - The JID of the new groupchat which replaces this one.
     */
    sendDestroyIQ (reason, new_jid) {
        const destroy = $build('destroy');
        if (new_jid) {
            destroy.attrs({ 'jid': new_jid });
        }
        const iq = $iq({
            'to': this.get('jid'),
            'type': 'set'
        })
            .c('query', { 'xmlns': Strophe.NS.MUC_OWNER })
            .cnode(destroy.node);
        if (reason && reason.length > 0) {
            iq.c('reason', reason);
        }
        return api.sendIQ(iq);
    },

    /**
     * Leave the groupchat.
     * @private
     * @method _converse.ChatRoom#leave
     * @param { string } [exit_msg] - Message to indicate your reason for leaving
     */
    async leave (exit_msg) {
        this.features.destroy();

        const disco_entity = _converse.disco_entities?.get(this.get('jid'));
        if (disco_entity) {
            await new Promise((success, error) => disco_entity.destroy({ success, error }));
        }
        if (api.connection.connected()) {
            api.user.presence.send('unavailable', this.getRoomJIDAndNick(), exit_msg);
        }
        u.safeSave(this.session, { 'connection_status': converse.ROOMSTATUS.DISCONNECTED });
    },

    async close (ev) {
        await this.leave();
        this.occupants.clearStore();

        if (ev?.name !== 'closeAllChatBoxes' && api.settings.get('muc_clear_messages_on_leave')) {
            this.clearMessages();
        }

        // Delete the session model
        await new Promise(resolve =>
            this.session.destroy({
                'success': resolve,
                'error': (m, e) => {
                    log.error(e);
                    resolve();
                }
            })
        );
        // Delete the features model
        await new Promise(resolve =>
            this.features.destroy({
                'success': resolve,
                'error': (m, e) => {
                    log.error(e);
                    resolve();
                }
            })
        );
        return _converse.ChatBox.prototype.close.call(this);
    },

    canModerateMessages () {
        const self = this.getOwnOccupant();
        return self && self.isModerator() && api.disco.supports(Strophe.NS.MODERATE, this.get('jid'));
    },

    /**
     * Return an array of unique nicknames based on all occupants and messages in this MUC.
     * @private
     * @method _converse.ChatRoom#getAllKnownNicknames
     * @returns { String[] }
     */
    getAllKnownNicknames () {
        return [
            ...new Set([...this.occupants.map(o => o.get('nick')), ...this.messages.map(m => m.get('nick'))])
        ].filter(n => n);
    },

    getAllKnownNicknamesRegex () {
        const longNickString = this.getAllKnownNicknames().join('|');
        const escapedLongNickString = p.escapeRegexString(longNickString);
        return RegExp(`(?:\\p{P}|\\p{Z}|^)@(${escapedLongNickString})(?![\\w@-])`, 'uig');
    },

    getOccupantByJID (jid) {
        return this.occupants.findOccupant({ jid });
    },

    getOccupantByNickname (nick) {
        return this.occupants.findOccupant({ nick });
    },

    /**
     * Given a text message, look for `@` mentions and turn them into
     * XEP-0372 references
     * @param { String } text
     */
    parseTextForReferences (text) {
        const mentions_regex = /(\p{P}|\p{Z}|^)([@][\w_-]+(?:\.\w+)*)/giu;
        if (!text || !mentions_regex.test(text)) {
            return [text, []];
        }

        const getMatchingNickname = p.findFirstMatchInArray(this.getAllKnownNicknames());

        const uriFromNickname = nickname => {
            const jid = this.get('jid');
            const occupant = this.getOccupant(nickname) || this.getOccupant(jid);
            const uri = (this.features.get('nonanonymous') && occupant?.get('jid')) || `${jid}/${nickname}`;
            return encodeURI(`xmpp:${uri}`);
        };

        const matchToReference = match => {
            let at_sign_index = match[0].indexOf('@');
            if (match[0][at_sign_index + 1] === '@') {
                // edge-case
                at_sign_index += 1;
            }
            const begin = match.index + at_sign_index;
            const end = begin + match[0].length - at_sign_index;
            const value = getMatchingNickname(match[1]);
            const type = 'mention';
            const uri = uriFromNickname(value);
            return { begin, end, value, type, uri };
        };

        const regex = this.getAllKnownNicknamesRegex();
        const mentions = [...text.matchAll(regex)].filter(m => !m[0].startsWith('/'));
        const references = mentions.map(matchToReference);

        const [updated_message, updated_references] = p.reduceTextFromReferences(text, references);
        return [updated_message, updated_references];
    },

    getOutgoingMessageAttributes (original_message, spoiler_hint) {
        const is_spoiler = this.get('composing_spoiler');
        const [text, references] = this.parseTextForReferences(original_message);
        const origin_id = u.getUniqueId();
        const body = text ? u.httpToGeoUri(u.shortnamesToUnicode(text), _converse) : undefined;
        return {
            body,
            is_spoiler,
            origin_id,
            references,
            'id': origin_id,
            'msgid': origin_id,
            'from': `${this.get('jid')}/${this.get('nick')}`,
            'fullname': this.get('nick'),
            'is_only_emojis': text ? u.isOnlyEmojis(text) : false,
            'message': body,
            'nick': this.get('nick'),
            'sender': 'me',
            'spoiler_hint': is_spoiler ? spoiler_hint : undefined,
            'type': 'groupchat'
        };
    },

    /**
     * Utility method to construct the JID for the current user as occupant of the groupchat.
     * @private
     * @method _converse.ChatRoom#getRoomJIDAndNick
     * @returns {string} - The groupchat JID with the user's nickname added at the end.
     * @example groupchat@conference.example.org/nickname
     */
    getRoomJIDAndNick () {
        const nick = this.get('nick');
        const jid = Strophe.getBareJidFromJid(this.get('jid'));
        return jid + (nick !== null ? `/${nick}` : '');
    },

    /**
     * Sends a message with the current XEP-0085 chat state of the user
     * as taken from the `chat_state` attribute of the {@link _converse.ChatRoom}.
     * @private
     * @method _converse.ChatRoom#sendChatState
     */
    sendChatState () {
        if (
            !api.settings.get('send_chat_state_notifications') ||
            !this.get('chat_state') ||
            this.session.get('connection_status') !== converse.ROOMSTATUS.ENTERED ||
            (this.features.get('moderated') && this.getOwnRole() === 'visitor')
        ) {
            return;
        }
        const allowed = api.settings.get('send_chat_state_notifications');
        if (Array.isArray(allowed) && !allowed.includes(this.get('chat_state'))) {
            return;
        }
        const chat_state = this.get('chat_state');
        if (chat_state === _converse.GONE) {
            // <gone/> is not applicable within MUC context
            return;
        }
        api.send(
            $msg({ 'to': this.get('jid'), 'type': 'groupchat' })
                .c(chat_state, { 'xmlns': Strophe.NS.CHATSTATES })
                .up()
                .c('no-store', { 'xmlns': Strophe.NS.HINTS })
                .up()
                .c('no-permanent-store', { 'xmlns': Strophe.NS.HINTS })
        );
    },

    /**
     * Send a direct invitation as per XEP-0249
     * @private
     * @method _converse.ChatRoom#directInvite
     * @param { String } recipient - JID of the person being invited
     * @param { String } [reason] - Reason for the invitation
     */
    directInvite (recipient, reason) {
        if (this.features.get('membersonly')) {
            // When inviting to a members-only groupchat, we first add
            // the person to the member list by giving them an
            // affiliation of 'member' otherwise they won't be able to join.
            this.updateMemberLists([{ 'jid': recipient, 'affiliation': 'member', 'reason': reason }]);
        }
        const attrs = {
            'xmlns': 'jabber:x:conference',
            'jid': this.get('jid')
        };
        if (reason !== null) {
            attrs.reason = reason;
        }
        if (this.get('password')) {
            attrs.password = this.get('password');
        }
        const invitation = $msg({
            'from': _converse.connection.jid,
            'to': recipient,
            'id': u.getUniqueId()
        }).c('x', attrs);
        api.send(invitation);
        /**
         * After the user has sent out a direct invitation (as per XEP-0249),
         * to a roster contact, asking them to join a room.
         * @event _converse#chatBoxMaximized
         * @type {object}
         * @property {_converse.ChatRoom} room
         * @property {string} recipient - The JID of the person being invited
         * @property {string} reason - The original reason for the invitation
         * @example _converse.api.listen.on('chatBoxMaximized', view => { ... });
         */
        api.trigger('roomInviteSent', {
            'room': this,
            'recipient': recipient,
            'reason': reason
        });
    },

    /**
     * Refresh the disco identity, features and fields for this {@link _converse.ChatRoom}.
     * *features* are stored on the features {@link Model} attribute on this {@link _converse.ChatRoom}.
     * *fields* are stored on the config {@link Model} attribute on this {@link _converse.ChatRoom}.
     * @private
     * @returns {Promise}
     */
    refreshDiscoInfo () {
        return api.disco
            .refresh(this.get('jid'))
            .then(() => this.getDiscoInfo())
            .catch(e => log.error(e));
    },

    /**
     * Fetch the *extended* MUC info from the server and cache it locally
     * https://xmpp.org/extensions/xep-0045.html#disco-roominfo
     * @private
     * @method _converse.ChatRoom#getDiscoInfo
     * @returns {Promise}
     */
    getDiscoInfo () {
        return api.disco
            .getIdentity('conference', 'text', this.get('jid'))
            .then(identity => this.save({ 'name': identity?.get('name') }))
            .then(() => this.getDiscoInfoFields())
            .then(() => this.getDiscoInfoFeatures())
            .catch(e => log.error(e));
    },

    /**
     * Fetch the *extended* MUC info fields from the server and store them locally
     * in the `config` {@link Model} attribute.
     * See: https://xmpp.org/extensions/xep-0045.html#disco-roominfo
     * @private
     * @method _converse.ChatRoom#getDiscoInfoFields
     * @returns {Promise}
     */
    async getDiscoInfoFields () {
        const fields = await api.disco.getFields(this.get('jid'));
        const config = fields.reduce((config, f) => {
            const name = f.get('var');
            if (name && name.startsWith('muc#roominfo_')) {
                config[name.replace('muc#roominfo_', '')] = f.get('value');
            }
            return config;
        }, {});
        this.config.save(config);
    },

    /**
     * Use converse-disco to populate the features {@link Model} which
     * is stored as an attibute on this {@link _converse.ChatRoom}.
     * The results may be cached. If you want to force fetching the features from the
     * server, call {@link _converse.ChatRoom#refreshDiscoInfo} instead.
     * @private
     * @returns {Promise}
     */
    async getDiscoInfoFeatures () {
        const features = await api.disco.getFeatures(this.get('jid'));
        const attrs = Object.assign(
            zipObject(
                converse.ROOM_FEATURES,
                converse.ROOM_FEATURES.map(() => false)
            ),
            { 'fetched': new Date().toISOString() }
        );
        features.each(feature => {
            const fieldname = feature.get('var');
            if (!fieldname.startsWith('muc_')) {
                if (fieldname === Strophe.NS.MAM) {
                    attrs.mam_enabled = true;
                }
                return;
            }
            attrs[fieldname.replace('muc_', '')] = true;
        });
        this.features.save(attrs);
    },

    /**
     * Send IQ stanzas to the server to set an affiliation for
     * the provided JIDs.
     * See: https://xmpp.org/extensions/xep-0045.html#modifymember
     *
     * Prosody doesn't accept multiple JIDs' affiliations
     * being set in one IQ stanza, so as a workaround we send
     * a separate stanza for each JID.
     * Related ticket: https://issues.prosody.im/345
     *
     * @private
     * @method _converse.ChatRoom#setAffiliation
     * @param { string } affiliation - The affiliation
     * @param { object } members - A map of jids, affiliations and
     *      optionally reasons. Only those entries with the
     *      same affiliation as being currently set will be considered.
     * @returns { Promise } A promise which resolves and fails depending on the XMPP server response.
     */
    setAffiliation (affiliation, members) {
        members = members.filter(m => m.affiliation === undefined || m.affiliation === affiliation);
        return Promise.all(members.map(m => this.sendAffiliationIQ(affiliation, m)));
    },

    /**
     * Given a <field> element, return a copy with a <value> child if
     * we can find a value for it in this rooms config.
     * @private
     * @method _converse.ChatRoom#addFieldValue
     * @returns { Element }
     */
    addFieldValue (field) {
        const type = field.getAttribute('type');
        if (type === 'fixed') {
            return field;
        }
        const fieldname = field.getAttribute('var').replace('muc#roomconfig_', '');
        const config = this.get('roomconfig');
        if (fieldname in config) {
            let values;
            switch (type) {
                case 'boolean':
                    values = [config[fieldname] ? 1 : 0];
                    break;
                case 'list-multi':
                    values = config[fieldname];
                    break;
                default:
                    values = [config[fieldname]];
            }
            field.innerHTML = values.map(v => $build('value').t(v)).join('');
        }
        return field;
    },

    /**
     * Automatically configure the groupchat based on this model's
     * 'roomconfig' data.
     * @private
     * @method _converse.ChatRoom#autoConfigureChatRoom
     * @returns { Promise<XMLElement> }
     * Returns a promise which resolves once a response IQ has
     * been received.
     */
    async autoConfigureChatRoom () {
        const stanza = await this.fetchRoomConfiguration();
        const fields = sizzle('field', stanza);
        const configArray = fields.map(f => this.addFieldValue(f));
        if (configArray.length) {
            return this.sendConfiguration(configArray);
        }
    },

    /**
     * Send an IQ stanza to fetch the groupchat configuration data.
     * Returns a promise which resolves once the response IQ
     * has been received.
     * @private
     * @method _converse.ChatRoom#fetchRoomConfiguration
     * @returns { Promise<XMLElement> }
     */
    fetchRoomConfiguration () {
        return api.sendIQ($iq({ 'to': this.get('jid'), 'type': 'get' }).c('query', { xmlns: Strophe.NS.MUC_OWNER }));
    },

    /**
     * Sends an IQ stanza with the groupchat configuration.
     * @private
     * @method _converse.ChatRoom#sendConfiguration
     * @param { Array } config - The groupchat configuration
     * @returns { Promise<XMLElement> } - A promise which resolves with
     * the `result` stanza received from the XMPP server.
     */
    sendConfiguration (config = []) {
        const iq = $iq({ to: this.get('jid'), type: 'set' })
            .c('query', { xmlns: Strophe.NS.MUC_OWNER })
            .c('x', { xmlns: Strophe.NS.XFORM, type: 'submit' });
        config.forEach(node => iq.cnode(node).up());
        return api.sendIQ(iq);
    },

    /**
     * Returns the `role` which the current user has in this MUC
     * @private
     * @method _converse.ChatRoom#getOwnRole
     * @returns { ('none'|'visitor'|'participant'|'moderator') }
     */
    getOwnRole () {
        return this.getOwnOccupant()?.attributes?.role;
    },

    /**
     * Returns the `affiliation` which the current user has in this MUC
     * @private
     * @method _converse.ChatRoom#getOwnAffiliation
     * @returns { ('none'|'outcast'|'member'|'admin'|'owner') }
     */
    getOwnAffiliation () {
        return this.getOwnOccupant()?.attributes?.affiliation || 'none';
    },

    /**
     * Get the {@link _converse.ChatRoomOccupant} instance which
     * represents the current user.
     * @private
     * @method _converse.ChatRoom#getOwnOccupant
     * @returns { _converse.ChatRoomOccupant }
     */
    getOwnOccupant () {
        return this.occupants.findWhere({ 'jid': _converse.bare_jid });
    },

    /**
     * Send an IQ stanza specifying an affiliation change.
     * @private
     * @method _converse.ChatRoom#
     * @param { String } affiliation: affiliation
     *     (could also be stored on the member object).
     * @param { Object } member: Map containing the member's jid and
     *     optionally a reason and affiliation.
     */
    sendAffiliationIQ (affiliation, member) {
        const iq = $iq({ to: this.get('jid'), type: 'set' })
            .c('query', { xmlns: Strophe.NS.MUC_ADMIN })
            .c('item', {
                'affiliation': member.affiliation || affiliation,
                'nick': member.nick,
                'jid': member.jid
            });
        if (member.reason !== undefined) {
            iq.c('reason', member.reason);
        }
        return api.sendIQ(iq);
    },

    /**
     * Send IQ stanzas to the server to modify affiliations for users in this groupchat.
     *
     * See: https://xmpp.org/extensions/xep-0045.html#modifymember
     * @private
     * @method _converse.ChatRoom#setAffiliations
     * @param { Object[] } members
     * @param { string } members[].jid - The JID of the user whose affiliation will change
     * @param { Array } members[].affiliation - The new affiliation for this user
     * @param { string } [members[].reason] - An optional reason for the affiliation change
     * @returns { Promise }
     */
    setAffiliations (members) {
        const affiliations = [...new Set(members.map(m => m.affiliation))];
        return Promise.all(affiliations.map(a => this.setAffiliation(a, members)));
    },

    /**
     * Send an IQ stanza to modify an occupant's role
     * @private
     * @method _converse.ChatRoom#setRole
     * @param { _converse.ChatRoomOccupant } occupant
     * @param { String } role
     * @param { String } reason
     * @param { function } onSuccess - callback for a succesful response
     * @param { function } onError - callback for an error response
     */
    setRole (occupant, role, reason, onSuccess, onError) {
        const item = $build('item', {
            'nick': occupant.get('nick'),
            role
        });
        const iq = $iq({
            'to': this.get('jid'),
            'type': 'set'
        })
            .c('query', { xmlns: Strophe.NS.MUC_ADMIN })
            .cnode(item.node);
        if (reason !== null) {
            iq.c('reason', reason);
        }
        return api
            .sendIQ(iq)
            .then(onSuccess)
            .catch(onError);
    },

    /**
     * @private
     * @method _converse.ChatRoom#getOccupant
     * @param { String } nickname_or_jid - The nickname or JID of the occupant to be returned
     * @returns { _converse.ChatRoomOccupant }
     */
    getOccupant (nickname_or_jid) {
        return u.isValidJID(nickname_or_jid)
            ? this.getOccupantByJID(nickname_or_jid)
            : this.getOccupantByNickname(nickname_or_jid);
    },

    /**
     * Return an array of occupant models that have the required role
     * @private
     * @method _converse.ChatRoom#getOccupantsWithRole
     * @param { String } role
     * @returns { _converse.ChatRoomOccupant[] }
     */
    getOccupantsWithRole (role) {
        return this.getOccupantsSortedBy('nick')
            .filter(o => o.get('role') === role)
            .map(item => {
                return {
                    'jid': item.get('jid'),
                    'nick': item.get('nick'),
                    'role': item.get('role')
                };
            });
    },

    /**
     * Return an array of occupant models that have the required affiliation
     * @private
     * @method _converse.ChatRoom#getOccupantsWithAffiliation
     * @param { String } affiliation
     * @returns { _converse.ChatRoomOccupant[] }
     */
    getOccupantsWithAffiliation (affiliation) {
        return this.getOccupantsSortedBy('nick')
            .filter(o => o.get('affiliation') === affiliation)
            .map(item => {
                return {
                    'jid': item.get('jid'),
                    'nick': item.get('nick'),
                    'affiliation': item.get('affiliation')
                };
            });
    },

    /**
     * Return an array of occupant models, sorted according to the passed-in attribute.
     * @private
     * @method _converse.ChatRoom#getOccupantsSortedBy
     * @param { String } attr - The attribute to sort the returned array by
     * @returns { _converse.ChatRoomOccupant[] }
     */
    getOccupantsSortedBy (attr) {
        return Array.from(this.occupants.models).sort((a, b) =>
            a.get(attr) < b.get(attr) ? -1 : a.get(attr) > b.get(attr) ? 1 : 0
        );
    },

    /**
     * Sends an IQ stanza to the server, asking it for the relevant affiliation list .
     * Returns an array of {@link MemberListItem} objects, representing occupants
     * that have the given affiliation.
     * See: https://xmpp.org/extensions/xep-0045.html#modifymember
     * @private
     * @method _converse.ChatRoom#getAffiliationList
     * @param { ("admin"|"owner"|"member") } affiliation
     * @returns { Promise<MemberListItem[]> }
     */
    async getAffiliationList (affiliation) {
        const iq = $iq({ to: this.get('jid'), type: 'get' })
            .c('query', { xmlns: Strophe.NS.MUC_ADMIN })
            .c('item', { 'affiliation': affiliation });
        const result = await api.sendIQ(iq, null, false);
        if (result === null) {
            const err_msg = `Error: timeout while fetching ${affiliation} list for MUC ${this.get('jid')}`;
            const err = new Error(err_msg);
            log.warn(err_msg);
            log.warn(result);
            return err;
        }
        if (u.isErrorStanza(result)) {
            const err_msg = `Error: not allowed to fetch ${affiliation} list for MUC ${this.get('jid')}`;
            const err = new Error(err_msg);
            log.warn(err_msg);
            log.warn(result);
            return err;
        }
        return parseMemberListIQ(result)
            .filter(p => p)
            .sort((a, b) => (a.nick < b.nick ? -1 : a.nick > b.nick ? 1 : 0));
    },

    /**
     * Fetch the lists of users with the given affiliations.
     * Then compute the delta between those users and
     * the passed in members, and if it exists, send the delta
     * to the XMPP server to update the member list.
     * @private
     * @method _converse.ChatRoom#updateMemberLists
     * @param { object } members - Map of member jids and affiliations.
     * @returns { Promise }
     *  A promise which is resolved once the list has been
     *  updated or once it's been established there's no need
     *  to update the list.
     */
    async updateMemberLists (members) {
        const all_affiliations = ['member', 'admin', 'owner'];
        const aff_lists = await Promise.all(all_affiliations.map(a => this.getAffiliationList(a)));
        const old_members = aff_lists.reduce((acc, val) => (u.isErrorObject(val) ? acc : [...val, ...acc]), []);
        await this.setAffiliations(muc_utils.computeAffiliationsDelta(true, false, members, old_members));
        await this.occupants.fetchMembers();
    },

    /**
     * Given a nick name, save it to the model state, otherwise, look
     * for a server-side reserved nickname or default configured
     * nickname and if found, persist that to the model state.
     * @private
     * @method _converse.ChatRoom#getAndPersistNickname
     * @returns { Promise<string> } A promise which resolves with the nickname
     */
    async getAndPersistNickname (nick) {
        nick = nick || this.get('nick') || (await this.getReservedNick()) || _converse.getDefaultMUCNickname();

        if (nick) {
            this.save({ nick }, { 'silent': true });
        }
        return nick;
    },

    /**
     * Use service-discovery to ask the XMPP server whether
     * this user has a reserved nickname for this groupchat.
     * If so, we'll use that, otherwise we render the nickname form.
     * @private
     * @method _converse.ChatRoom#getReservedNick
     * @returns { Promise<string> } A promise which resolves with the reserved nick or null
     */
    async getReservedNick () {
        const stanza = $iq({
            'to': this.get('jid'),
            'from': _converse.connection.jid,
            'type': 'get'
        }).c('query', {
            'xmlns': Strophe.NS.DISCO_INFO,
            'node': 'x-roomuser-item'
        });
        const result = await api.sendIQ(stanza, null, false);
        if (u.isErrorObject(result)) {
            throw result;
        }
        const identity_el = result.querySelector('query[node="x-roomuser-item"] identity');
        return identity_el ? identity_el.getAttribute('name') : null;
    },

    async registerNickname () {
        // See https://xmpp.org/extensions/xep-0045.html#register
        const __ = _converse.__;
        const nick = this.get('nick');
        const jid = this.get('jid');
        let iq, err_msg;
        try {
            iq = await api.sendIQ(
                $iq({
                    'to': jid,
                    'from': _converse.connection.jid,
                    'type': 'get'
                }).c('query', { 'xmlns': Strophe.NS.MUC_REGISTER })
            );
        } catch (e) {
            if (sizzle(`not-allowed[xmlns="${Strophe.NS.STANZAS}"]`, e).length) {
                err_msg = __("You're not allowed to register yourself in this groupchat.");
            } else if (sizzle(`registration-required[xmlns="${Strophe.NS.STANZAS}"]`, e).length) {
                err_msg = __("You're not allowed to register in this groupchat because it's members-only.");
            }
            log.error(e);
            return err_msg;
        }
        const required_fields = sizzle('field required', iq).map(f => f.parentElement);
        if (required_fields.length > 1 && required_fields[0].getAttribute('var') !== 'muc#register_roomnick') {
            return log.error(`Can't register the user register in the groupchat ${jid} due to the required fields`);
        }
        try {
            await api.sendIQ(
                $iq({
                    'to': jid,
                    'from': _converse.connection.jid,
                    'type': 'set'
                })
                    .c('query', { 'xmlns': Strophe.NS.MUC_REGISTER })
                    .c('x', { 'xmlns': Strophe.NS.XFORM, 'type': 'submit' })
                    .c('field', { 'var': 'FORM_TYPE' })
                    .c('value')
                    .t('http://jabber.org/protocol/muc#register')
                    .up()
                    .up()
                    .c('field', { 'var': 'muc#register_roomnick' })
                    .c('value')
                    .t(nick)
            );
        } catch (e) {
            if (sizzle(`service-unavailable[xmlns="${Strophe.NS.STANZAS}"]`, e).length) {
                err_msg = __("Can't register your nickname in this groupchat, it doesn't support registration.");
            } else if (sizzle(`bad-request[xmlns="${Strophe.NS.STANZAS}"]`, e).length) {
                err_msg = __("Can't register your nickname in this groupchat, invalid data form supplied.");
            }
            log.error(err_msg);
            log.error(e);
            return err_msg;
        }
    },

    /**
     * Given a presence stanza, update the occupant model based on its contents.
     * @private
     * @method _converse.ChatRoom#updateOccupantsOnPresence
     * @param { XMLElement } pres - The presence stanza
     */
    updateOccupantsOnPresence (pres) {
        const data = parseMUCPresence(pres);
        if (data.type === 'error' || (!data.jid && !data.nick)) {
            return true;
        }
        const occupant = this.occupants.findOccupant(data);
        // Destroy an unavailable occupant if this isn't a nick change operation and if they're not affiliated
        if (
            data.type === 'unavailable' &&
            occupant &&
            !data.states.includes(converse.MUC_NICK_CHANGED_CODE) &&
            !['admin', 'owner', 'member'].includes(data['affiliation'])
        ) {
            // Before destroying we set the new data, so that we can show the disconnection message
            occupant.set(data);
            occupant.destroy();
            return;
        }
        const jid = data.jid || '';
        const attributes = Object.assign(data, {
            'jid': Strophe.getBareJidFromJid(jid) || occupant?.attributes?.jid,
            'resource': Strophe.getResourceFromJid(jid) || occupant?.attributes?.resource
        });
        if (occupant) {
            occupant.save(attributes);
        } else {
            this.occupants.create(attributes);
        }
    },

    fetchFeaturesIfConfigurationChanged (stanza) {
        // 104: configuration change
        // 170: logging enabled
        // 171: logging disabled
        // 172: room no longer anonymous
        // 173: room now semi-anonymous
        // 174: room now fully anonymous
        const codes = ['104', '170', '171', '172', '173', '174'];
        if (sizzle('status', stanza).filter(e => codes.includes(e.getAttribute('status'))).length) {
            this.refreshDiscoInfo();
        }
    },

    /**
     * Given two JIDs, which can be either user JIDs or MUC occupant JIDs,
     * determine whether they belong to the same user.
     * @private
     * @method _converse.ChatRoom#isSameUser
     * @param { String } jid1
     * @param { String } jid2
     * @returns { Boolean }
     */
    isSameUser (jid1, jid2) {
        const bare_jid1 = Strophe.getBareJidFromJid(jid1);
        const bare_jid2 = Strophe.getBareJidFromJid(jid2);
        const resource1 = Strophe.getResourceFromJid(jid1);
        const resource2 = Strophe.getResourceFromJid(jid2);
        if (u.isSameBareJID(jid1, jid2)) {
            if (bare_jid1 === this.get('jid')) {
                // MUC JIDs
                return resource1 === resource2;
            } else {
                return true;
            }
        } else {
            const occupant1 =
                bare_jid1 === this.get('jid')
                    ? this.occupants.findOccupant({ 'nick': resource1 })
                    : this.occupants.findOccupant({ 'jid': bare_jid1 });

            const occupant2 =
                bare_jid2 === this.get('jid')
                    ? this.occupants.findOccupant({ 'nick': resource2 })
                    : this.occupants.findOccupant({ 'jid': bare_jid2 });
            return occupant1 === occupant2;
        }
    },

    async isSubjectHidden () {
        const jids = await api.user.settings.get('mucs_with_hidden_subject', []);
        return jids.includes(this.get('jid'));
    },

    async toggleSubjectHiddenState () {
        const muc_jid = this.get('jid');
        const jids = await api.user.settings.get('mucs_with_hidden_subject', []);
        if (jids.includes(this.get('jid'))) {
            api.user.settings.set(
                'mucs_with_hidden_subject',
                jids.filter(jid => jid !== muc_jid)
            );
        } else {
            api.user.settings.set('mucs_with_hidden_subject', [...jids, muc_jid]);
        }
    },

    /**
     * Handle a possible subject change and return `true` if so.
     * @private
     * @method _converse.ChatRoom#handleSubjectChange
     * @param { object } attrs - Attributes representing a received
     *  message, as returned by {@link parseMUCMessage}
     */
    async handleSubjectChange (attrs) {
        const __ = _converse.__;
        if (typeof attrs.subject === 'string' && !attrs.thread && !attrs.message) {
            // https://xmpp.org/extensions/xep-0045.html#subject-mod
            // -----------------------------------------------------
            // The subject is changed by sending a message of type "groupchat" to the <room@service>,
            // where the <message/> MUST contain a <subject/> element that specifies the new subject but
            // MUST NOT contain a <body/> element (or a <thread/> element).
            const subject = attrs.subject;
            const author = attrs.nick;
            u.safeSave(this, { 'subject': { author, 'text': attrs.subject || '' } });
            if (!attrs.is_delayed && author) {
                const message = subject ? __('Topic set by %1$s', author) : __('Topic cleared by %1$s', author);
                const prev_msg = this.messages.last();
                if (
                    prev_msg?.get('nick') !== attrs.nick ||
                    prev_msg?.get('type') !== 'info' ||
                    prev_msg?.get('message') !== message
                ) {
                    this.createMessage({ message, 'nick': attrs.nick, 'type': 'info' });
                }
                if (await this.isSubjectHidden()) {
                    this.toggleSubjectHiddenState();
                }
            }
            return true;
        }
        return false;
    },

    /**
     * Set the subject for this {@link _converse.ChatRoom}
     * @private
     * @method _converse.ChatRoom#setSubject
     * @param { String } value
     */
    setSubject (value = '') {
        api.send(
            $msg({
                to: this.get('jid'),
                from: _converse.connection.jid,
                type: 'groupchat'
            })
                .c('subject', { xmlns: 'jabber:client' })
                .t(value)
                .tree()
        );
    },

    /**
     * Is this a chat state notification that can be ignored,
     * because it's old or because it's from us.
     * @private
     * @method _converse.ChatRoom#ignorableCSN
     * @param { Object } attrs - The message attributes
     */
    ignorableCSN (attrs) {
        return attrs.chat_state && !attrs.body && (attrs.is_delayed || this.isOwnMessage(attrs));
    },

    /**
     * Determines whether the message is from ourselves by checking
     * the `from` attribute. Doesn't check the `type` attribute.
     * @private
     * @method _converse.ChatRoom#isOwnMessage
     * @param { Object|XMLElement|_converse.Message } msg
     * @returns { boolean }
     */
    isOwnMessage (msg) {
        let from;
        if (isElement(msg)) {
            from = msg.getAttribute('from');
        } else if (msg instanceof _converse.Message) {
            from = msg.get('from');
        } else {
            from = msg.from;
        }
        return Strophe.getResourceFromJid(from) == this.get('nick');
    },

    getUpdatedMessageAttributes (message, attrs) {
        const new_attrs = _converse.ChatBox.prototype.getUpdatedMessageAttributes.call(this, message, attrs);
        if (this.isOwnMessage(attrs)) {
            const stanza_id_keys = Object.keys(attrs).filter(k => k.startsWith('stanza_id'));
            Object.assign(new_attrs, pick(attrs, stanza_id_keys));
            if (!message.get('received')) {
                new_attrs.received = new Date().toISOString();
            }
        }
        return new_attrs;
    },

    /**
     * Send a MUC-0410 MUC Self-Ping stanza to room to determine
     * whether we're still joined.
     * @async
     * @private
     * @method _converse.ChatRoom#isJoined
     * @returns {Promise<boolean>}
     */
    async isJoined () {
        const jid = this.get('jid');
        const ping = $iq({
            'to': `${jid}/${this.get('nick')}`,
            'type': 'get'
        }).c('ping', { 'xmlns': Strophe.NS.PING });
        try {
            await api.sendIQ(ping);
        } catch (e) {
            if (e === null) {
                log.warn(`isJoined: Timeout error while checking whether we're joined to MUC: ${jid}`);
            } else {
                log.warn(`isJoined: Apparently we're no longer connected to MUC: ${jid}`);
            }
            return false;
        }
        return true;
    },

    /**
     * Check whether we're still joined and re-join if not
     * @async
     * @private
     * @method _converse.ChatRoom#rejoinIfNecessary
     */
    async rejoinIfNecessary () {
        if (!(await this.isJoined())) {
            this.rejoin();
            return true;
        }
    },

    /**
     * @private
     * @method _converse.ChatRoom#shouldShowErrorMessage
     * @returns {Promise<boolean>}
     */
    async shouldShowErrorMessage (attrs) {
        if (attrs['error_condition'] === 'not-acceptable' && (await this.rejoinIfNecessary())) {
            return false;
        }
        return _converse.ChatBox.prototype.shouldShowErrorMessage.call(this, attrs);
    },

    /**
     * Looks whether we already have a moderation message for this
     * incoming message. If so, it's considered "dangling" because
     * it probably hasn't been applied to anything yet, given that
     * the relevant message is only coming in now.
     * @private
     * @method _converse.ChatRoom#findDanglingModeration
     * @param { object } attrs - Attributes representing a received
     *  message, as returned by {@link parseMUCMessage}
     * @returns { _converse.ChatRoomMessage }
     */
    findDanglingModeration (attrs) {
        if (!this.messages.length) {
            return null;
        }
        // Only look for dangling moderation if there are newer
        // messages than this one, since moderation come after.
        if (this.messages.last().get('time') > attrs.time) {
            // Search from latest backwards
            const messages = Array.from(this.messages.models);
            const stanza_id = attrs[`stanza_id ${this.get('jid')}`];
            if (!stanza_id) {
                return null;
            }
            messages.reverse();
            return messages.find(
                ({ attributes }) =>
                    attributes.moderated === 'retracted' &&
                    attributes.moderated_id === stanza_id &&
                    attributes.moderated_by
            );
        }
    },

    /**
     * Handles message moderation based on the passed in attributes.
     * @private
     * @method _converse.ChatRoom#handleModeration
     * @param { object } attrs - Attributes representing a received
     *  message, as returned by {@link parseMUCMessage}
     * @returns { Boolean } Returns `true` or `false` depending on
     *  whether a message was moderated or not.
     */
    async handleModeration (attrs) {
        const MODERATION_ATTRIBUTES = ['editable', 'moderated', 'moderated_by', 'moderated_id', 'moderation_reason'];
        if (attrs.moderated === 'retracted') {
            const query = {};
            const key = `stanza_id ${this.get('jid')}`;
            query[key] = attrs.moderated_id;
            const message = this.messages.findWhere(query);
            if (!message) {
                attrs['dangling_moderation'] = true;
                await this.createMessage(attrs);
                return true;
            }
            message.save(pick(attrs, MODERATION_ATTRIBUTES));
            return true;
        } else {
            // Check if we have dangling moderation message
            const message = this.findDanglingModeration(attrs);
            if (message) {
                const moderation_attrs = pick(message.attributes, MODERATION_ATTRIBUTES);
                const new_attrs = Object.assign({ 'dangling_moderation': false }, attrs, moderation_attrs);
                delete new_attrs['id']; // Delete id, otherwise a new cache entry gets created
                message.save(new_attrs);
                return true;
            }
        }
        return false;
    },

    /**
     * @param {String} actor - The nickname of the actor that caused the notification
     * @param {String|Array<String>} states - The state or states representing the type of notificcation
     */
    removeNotification (actor, states) {
        const actors_per_state = this.notifications.toJSON();
        states = Array.isArray(states) ? states : [states];
        states.forEach(state => {
            const existing_actors = Array.from(actors_per_state[state] || []);
            if (existing_actors.includes(actor)) {
                const idx = existing_actors.indexOf(actor);
                existing_actors.splice(idx, 1);
                this.notifications.set(state, Array.from(existing_actors));
            }
        });
    },

    /**
     * Update the notifications model by adding the passed in nickname
     * to the array of nicknames that all match a particular state.
     *
     * Removes the nickname from any other states it might be associated with.
     *
     * The state can be a XEP-0085 Chat State or a XEP-0045 join/leave
     * state.
     * @param {String} actor - The nickname of the actor that causes the notification
     * @param {String} state - The state representing the type of notificcation
     */
    updateNotifications (actor, state) {
        const actors_per_state = this.notifications.toJSON();
        const existing_actors = actors_per_state[state] || [];
        if (existing_actors.includes(actor)) {
            return;
        }
        const reducer = (out, s) => {
            if (s === state) {
                out[s] = [...existing_actors, actor];
            } else {
                out[s] = (actors_per_state[s] || []).filter(a => a !== actor);
            }
            return out;
        };
        const actors_per_chat_state = converse.CHAT_STATES.reduce(reducer, {});
        const actors_per_traffic_state = converse.MUC_TRAFFIC_STATES_LIST.reduce(reducer, {});
        const actors_per_role_change = converse.MUC_ROLE_CHANGES_LIST.reduce(reducer, {});
        this.notifications.set(Object.assign(actors_per_chat_state, actors_per_traffic_state, actors_per_role_change));
        window.setTimeout(() => this.removeNotification(actor, state), 10000);
    },

    /**
     * Handler for all MUC messages sent to this groupchat. This method
     * shouldn't be called directly, instead {@link _converse.ChatRoom#queueMessage}
     * should be called.
     * @private
     * @method _converse.ChatRoom#onMessage
     * @param { MessageAttributes } attrs - A promise which resolves to the message attributes.
     */
    async onMessage (attrs) {
        attrs = await attrs;
        if (u.isErrorObject(attrs)) {
            attrs.stanza && log.error(attrs.stanza);
            return log.error(attrs.message);
        }
        const message = this.getDuplicateMessage(attrs);
        if (message) {
            return this.updateMessage(message, attrs);
        } else if (attrs.is_valid_receipt_request || attrs.is_marker || this.ignorableCSN(attrs)) {
            return;
        }

        if (
            (await this.handleRetraction(attrs)) ||
            (await this.handleModeration(attrs)) ||
            (await this.handleSubjectChange(attrs))
        ) {
            return this.removeNotification(attrs.nick, ['composing', 'paused']);
        }
        this.setEditable(attrs, attrs.time);

        if (attrs['chat_state']) {
            this.updateNotifications(attrs.nick, attrs.chat_state);
        }
        if (u.shouldCreateGroupchatMessage(attrs)) {
            const msg = this.handleCorrection(attrs) || (await this.createMessage(attrs));
            this.removeNotification(attrs.nick, ['composing', 'paused']);
            this.handleUnreadMessage(msg);
        }
    },

    handleModifyError (pres) {
        const text = pres.querySelector('error text')?.textContent;
        if (text) {
            if (this.session.get('connection_status') === converse.ROOMSTATUS.CONNECTING) {
                this.setDisconnectionMessage(text);
            } else {
                const attrs = {
                    'type': 'error',
                    'message': text,
                    'is_ephemeral': true
                };
                this.createMessage(attrs);
            }
        }
    },

    /**
     * Handle a presence stanza that disconnects the user from the MUC
     * @param { XMLElement } stanza
     */
    handleDisconnection (stanza) {
        const is_self = stanza.querySelector("status[code='110']") !== null;
        const x = sizzle(`x[xmlns="${Strophe.NS.MUC_USER}"]`, stanza).pop();
        if (!x) {
            return;
        }
        const codes = sizzle('status', x).map(s => s.getAttribute('code'));
        const disconnection_codes = intersection(codes, Object.keys(_converse.muc.disconnect_messages));
        const disconnected = is_self && disconnection_codes.length > 0;
        if (!disconnected) {
            return;
        }
        // By using querySelector we assume here there is
        // one <item> per <x xmlns='http://jabber.org/protocol/muc#user'>
        // element. This appears to be a safe assumption, since
        // each <x/> element pertains to a single user.
        const item = x.querySelector('item');
        const reason = item ? item.querySelector('reason')?.textContent : undefined;
        const actor = item ? invoke(item.querySelector('actor'), 'getAttribute', 'nick') : undefined;
        const message = _converse.muc.disconnect_messages[disconnection_codes[0]];
        this.setDisconnectionMessage(message, reason, actor);
    },

    getActionInfoMessage (code, nick, actor) {
        const __ = _converse.__;
        if (code === '301') {
            return actor ? __('%1$s has been banned by %2$s', nick, actor) : __('%1$s has been banned', nick);
        } else if (code === '303') {
            return __("%1$s's nickname has changed", nick);
        } else if (code === '307') {
            return actor ? __('%1$s has been kicked out by %2$s', nick, actor) : __('%1$s has been kicked out', nick);
        } else if (code === '321') {
            return __('%1$s has been removed because of an affiliation change', nick);
        } else if (code === '322') {
            return __('%1$s has been removed for not being a member', nick);
        }
    },

    createAffiliationChangeMessage (occupant) {
        const __ = _converse.__;
        const previous_affiliation = occupant._previousAttributes.affiliation;

        if (!previous_affiliation) {
            // If no previous affiliation was set, then we don't
            // interpret this as an affiliation change.
            // For example, if muc_send_probes is true, then occupants
            // are created based on incoming messages, in which case
            // we don't yet know the affiliation
            return;
        }

        const current_affiliation = occupant.get('affiliation');
        if (previous_affiliation === 'admin' && _converse.isInfoVisible(converse.AFFILIATION_CHANGES.EXADMIN)) {
            this.createMessage({
                'type': 'info',
                'message': __('%1$s is no longer an admin of this groupchat', occupant.get('nick'))
            });
        } else if (previous_affiliation === 'owner' && _converse.isInfoVisible(converse.AFFILIATION_CHANGES.EXOWNER)) {
            this.createMessage({
                'type': 'info',
                'message': __('%1$s is no longer an owner of this groupchat', occupant.get('nick'))
            });
        } else if (
            previous_affiliation === 'outcast' &&
            _converse.isInfoVisible(converse.AFFILIATION_CHANGES.EXOUTCAST)
        ) {
            this.createMessage({
                'type': 'info',
                'message': __('%1$s is no longer banned from this groupchat', occupant.get('nick'))
            });
        }

        if (
            current_affiliation === 'none' &&
            previous_affiliation === 'member' &&
            _converse.isInfoVisible(converse.AFFILIATION_CHANGES.EXMEMBER)
        ) {
            this.createMessage({
                'type': 'info',
                'message': __('%1$s is no longer a member of this groupchat', occupant.get('nick'))
            });
        }

        if (current_affiliation === 'member' && _converse.isInfoVisible(converse.AFFILIATION_CHANGES.MEMBER)) {
            this.createMessage({
                'type': 'info',
                'message': __('%1$s is now a member of this groupchat', occupant.get('nick'))
            });
        } else if (
            (current_affiliation === 'admin' && _converse.isInfoVisible(converse.AFFILIATION_CHANGES.ADMIN)) ||
            (current_affiliation == 'owner' && _converse.isInfoVisible(converse.AFFILIATION_CHANGES.OWNER))
        ) {
            // For example: AppleJack is now an (admin|owner) of this groupchat
            this.createMessage({
                'type': 'info',
                'message': __('%1$s is now an %2$s of this groupchat', occupant.get('nick'), current_affiliation)
            });
        }
    },

    createRoleChangeMessage (occupant, changed) {
        if (changed === 'none' || occupant.changed.affiliation) {
            // We don't inform of role changes if they accompany affiliation changes.
            return;
        }
        const previous_role = occupant._previousAttributes.role;
        if (previous_role === 'moderator' && _converse.isInfoVisible(converse.MUC_ROLE_CHANGES.DEOP)) {
            this.updateNotifications(occupant.get('nick'), converse.MUC_ROLE_CHANGES.DEOP);
        } else if (previous_role === 'visitor' && _converse.isInfoVisible(converse.MUC_ROLE_CHANGES.VOICE)) {
            this.updateNotifications(occupant.get('nick'), converse.MUC_ROLE_CHANGES.VOICE);
        }
        if (occupant.get('role') === 'visitor' && _converse.isInfoVisible(converse.MUC_ROLE_CHANGES.MUTE)) {
            this.updateNotifications(occupant.get('nick'), converse.MUC_ROLE_CHANGES.MUTE);
        } else if (occupant.get('role') === 'moderator') {
            if (
                !['owner', 'admin'].includes(occupant.get('affiliation')) &&
                _converse.isInfoVisible(converse.MUC_ROLE_CHANGES.OP)
            ) {
                // Oly show this message if the user isn't already
                // an admin or owner, otherwise this isn't new information.
                this.updateNotifications(occupant.get('nick'), converse.MUC_ROLE_CHANGES.OP);
            }
        }
    },

    /**
     * Create an info message based on a received MUC status code
     * @private
     * @method _converse.ChatRoom#createInfoMessage
     * @param { string } code - The MUC status code
     * @param { XMLElement } stanza - The original stanza that contains the code
     * @param { Boolean } is_self - Whether this stanza refers to our own presence
     */
    createInfoMessage (code, stanza, is_self) {
        const __ = _converse.__;
        const data = { 'type': 'info' };
        if (!_converse.isInfoVisible(code)) {
            return;
        }
        if (code === '110' || (code === '100' && !is_self)) {
            return;
        } else if (code in _converse.muc.info_messages) {
            data.message = _converse.muc.info_messages[code];
        } else if (!is_self && ACTION_INFO_CODES.includes(code)) {
            const nick = Strophe.getResourceFromJid(stanza.getAttribute('from'));
            const item = stanza.querySelector(`x[xmlns="${Strophe.NS.MUC_USER}"] item`);
            data.actor = item ? item.querySelector('actor')?.getAttribute('nick') : undefined;
            data.reason = item ? item.querySelector('reason')?.textContent : undefined;
            data.message = this.getActionInfoMessage(code, nick, data.actor);
        } else if (is_self && code in _converse.muc.new_nickname_messages) {
            // XXX: Side-effect of setting the nick. Should ideally be refactored out of this method
            let nick;
            if (is_self && code === '210') {
                nick = Strophe.getResourceFromJid(stanza.getAttribute('from'));
            } else if (is_self && code === '303') {
                nick = stanza.querySelector(`x[xmlns="${Strophe.NS.MUC_USER}"] item`).getAttribute('nick');
            }
            this.save('nick', nick);
            data.message = __(_converse.muc.new_nickname_messages[code], nick);
        }
        if (data.message) {
            if (code === '201' && this.messages.findWhere(data)) {
                return;
            } else if (
                code in _converse.muc.info_messages &&
                this.messages.length &&
                this.messages.pop().get('message') === data.message
            ) {
                // XXX: very naive duplication checking
                return;
            }
            this.createMessage(data);
        }
    },

    /**
     * Create info messages based on a received presence or message stanza
     * @private
     * @method _converse.ChatRoom#createInfoMessages
     * @param { XMLElement } stanza
     */
    createInfoMessages (stanza) {
        const codes = sizzle(`x[xmlns="${Strophe.NS.MUC_USER}"] status`, stanza).map(s => s.getAttribute('code'));
        if (codes.includes('333') && codes.includes('307')) {
            // See: https://github.com/xsf/xeps/pull/969/files#diff-ac5113766e59219806793c1f7d967f1bR4966
            codes.splice(codes.indexOf('307'), 1);
        }
        const is_self = codes.includes('110');
        codes.forEach(code => this.createInfoMessage(code, stanza, is_self));
    },

    setDisconnectionMessage (message, reason, actor) {
        this.save({
            'disconnection_message': message,
            'disconnection_reason': reason,
            'disconnection_actor': actor
        });
        this.session.save({ 'connection_status': converse.ROOMSTATUS.DISCONNECTED });
    },

    onNicknameClash (presence) {
        const __ = _converse.__;
        if (api.settings.get('muc_nickname_from_jid')) {
            const nick = presence.getAttribute('from').split('/')[1];
            if (nick === _converse.getDefaultMUCNickname()) {
                this.join(nick + '-2');
            } else {
                const del = nick.lastIndexOf('-');
                const num = nick.substring(del + 1, nick.length);
                this.join(nick.substring(0, del + 1) + String(Number(num) + 1));
            }
        } else {
            this.save({
                'nickname_validation_message': __(
                    'The nickname you chose is reserved or ' + 'currently in use, please choose a different one.'
                )
            });
            this.session.save({ 'connection_status': converse.ROOMSTATUS.NICKNAME_REQUIRED });
        }
    },

    /**
     * Parses a <presence> stanza with type "error" and sets the proper
     * `connection_status` value for this {@link _converse.ChatRoom} as
     * well as any additional output that can be shown to the user.
     * @private
     * @param { XMLElement } stanza - The presence stanza
     */
    onErrorPresence (stanza) {
        const __ = _converse.__;
        const error = stanza.querySelector('error');
        const error_type = error.getAttribute('type');
        const reason = sizzle(`text[xmlns="${Strophe.NS.STANZAS}"]`, error).pop()?.textContent;

        if (error_type === 'modify') {
            this.handleModifyError(stanza);
        } else if (error_type === 'auth') {
            if (sizzle(`not-authorized[xmlns="${Strophe.NS.STANZAS}"]`, error).length) {
                this.save({ 'password_validation_message': reason || __('Password incorrect') });
                this.session.save({ 'connection_status': converse.ROOMSTATUS.PASSWORD_REQUIRED });
            }
            if (error.querySelector('registration-required')) {
                const message = __('You are not on the member list of this groupchat.');
                this.setDisconnectionMessage(message, reason);
            } else if (error.querySelector('forbidden')) {
                const message = __('You have been banned from this groupchat.');
                this.setDisconnectionMessage(message, reason);
            }
        } else if (error_type === 'cancel') {
            if (error.querySelector('not-allowed')) {
                const message = __('You are not allowed to create new groupchats.');
                this.setDisconnectionMessage(message, reason);
            } else if (error.querySelector('not-acceptable')) {
                const message = __("Your nickname doesn't conform to this groupchat's policies.");
                this.setDisconnectionMessage(message, reason);
            } else if (sizzle(`gone[xmlns="${Strophe.NS.STANZAS}"]`, error).length) {
                const moved_jid = sizzle(`gone[xmlns="${Strophe.NS.STANZAS}"]`, error)
                    .pop()
                    ?.textContent.replace(/^xmpp:/, '')
                    .replace(/\?join$/, '');
                this.save({ moved_jid, 'destroyed_reason': reason });
                this.session.save({ 'connection_status': converse.ROOMSTATUS.DESTROYED });
            } else if (error.querySelector('conflict')) {
                this.onNicknameClash(stanza);
            } else if (error.querySelector('item-not-found')) {
                const message = __('This groupchat does not (yet) exist.');
                this.setDisconnectionMessage(message, reason);
            } else if (error.querySelector('service-unavailable')) {
                const message = __('This groupchat has reached its maximum number of participants.');
                this.setDisconnectionMessage(message, reason);
            } else if (error.querySelector('remote-server-not-found')) {
                const message = __('Remote server not found');
                const feedback = reason ? __('The explanation given is: "%1$s".', reason) : undefined;
                this.setDisconnectionMessage(message, feedback);
            }
        }
    },

    /**
     * Listens for incoming presence stanzas from the service that hosts this MUC
     * @private
     * @method _converse.ChatRoom#onPresenceFromMUCHost
     * @param { XMLElement } stanza - The presence stanza
     */
    onPresenceFromMUCHost (stanza) {
        if (stanza.getAttribute('type') === 'error') {
            const error = stanza.querySelector('error');
            if (error?.getAttribute('type') === 'wait' && error?.querySelector('resource-constraint')) {
                // If we get a <resource-constraint> error, we assume it's in context of XEP-0437 RAI.
                // We remove this MUC's host from the list of enabled domains and rejoin the MUC.
                if (this.session.get('connection_status') === converse.ROOMSTATUS.DISCONNECTED) {
                    this.rejoin();
                }
            }
        }
    },

    /**
     * Handles incoming presence stanzas coming from the MUC
     * @private
     * @method _converse.ChatRoom#onPresence
     * @param { XMLElement } stanza
     */
    onPresence (stanza) {
        if (stanza.getAttribute('type') === 'error') {
            return this.onErrorPresence(stanza);
        }
        this.createInfoMessages(stanza);
        if (stanza.querySelector("status[code='110']")) {
            this.onOwnPresence(stanza);
            if (
                this.getOwnRole() !== 'none' &&
                this.session.get('connection_status') === converse.ROOMSTATUS.CONNECTING
            ) {
                this.session.save('connection_status', converse.ROOMSTATUS.CONNECTED);
            }
        } else {
            this.updateOccupantsOnPresence(stanza);
        }
    },

    /**
     * Handles a received presence relating to the current user.
     *
     * For locked groupchats (which are by definition "new"), the
     * groupchat will either be auto-configured or created instantly
     * (with default config) or a configuration groupchat will be
     * rendered.
     *
     * If the groupchat is not locked, then the groupchat will be
     * auto-configured only if applicable and if the current
     * user is the groupchat's owner.
     * @private
     * @method _converse.ChatRoom#onOwnPresence
     * @param { XMLElement } pres - The stanza
     */
    async onOwnPresence (stanza) {
        await this.occupants.fetched;
        if (stanza.getAttribute('type') !== 'unavailable') {
            const old_status = this.session.get('connection_status');
            if (old_status !== converse.ROOMSTATUS.ENTERED) {
                // Set connection_status before creating the occupant, but
                // only trigger afterwards, so that plugins can access the
                // occupant in their event handlers.
                this.session.save('connection_status', converse.ROOMSTATUS.ENTERED, { 'silent': true });
                this.updateOccupantsOnPresence(stanza);
                this.session.trigger('change:connection_status', this.session, old_status);
            } else {
                this.updateOccupantsOnPresence(stanza);
            }
        } else {
            this.updateOccupantsOnPresence(stanza);
        }

        if (stanza.getAttribute('type') === 'unavailable') {
            this.handleDisconnection(stanza);
            return;
        } else {
            const locked_room = stanza.querySelector("status[code='201']");
            if (locked_room) {
                if (this.get('auto_configure')) {
                    this.autoConfigureChatRoom().then(() => this.refreshDiscoInfo());
                } else if (api.settings.get('muc_instant_rooms')) {
                    // Accept default configuration
                    this.sendConfiguration().then(() => this.refreshDiscoInfo());
                } else {
                    /**
                     * Triggered when a new room has been created which first needs to be configured
                     * and when `auto_configure` is set to `false`.
                     * Used by `_converse.ChatRoomView` in order to know when to render the
                     * configuration form for a new room.
                     * @event _converse.ChatRoom#configurationNeeded
                     * @example _converse.api.listen.on('configurationNeeded', () => { ... });
                     */
                    this.trigger('configurationNeeded');
                    return; // We haven't yet entered the groupchat, so bail here.
                }
            } else if (!this.features.get('fetched')) {
                // The features for this groupchat weren't fetched.
                // That must mean it's a new groupchat without locking
                // (in which case Prosody doesn't send a 201 status),
                // otherwise the features would have been fetched in
                // the "initialize" method already.
                if (this.getOwnAffiliation() === 'owner' && this.get('auto_configure')) {
                    this.autoConfigureChatRoom().then(() => this.refreshDiscoInfo());
                } else {
                    this.getDiscoInfo();
                }
            }
        }
        this.session.save({ 'connection_status': converse.ROOMSTATUS.ENTERED });
    },

    /**
     * Returns a boolean to indicate whether the current user
     * was mentioned in a message.
     * @private
     * @method _converse.ChatRoom#isUserMentioned
     * @param { String } - The text message
     */
    isUserMentioned (message) {
        const nick = this.get('nick');
        if (message.get('references').length) {
            const mentions = message
                .get('references')
                .filter(ref => ref.type === 'mention')
                .map(ref => ref.value);
            return mentions.includes(nick);
        } else {
            return new RegExp(`\\b${nick}\\b`).test(message.get('message'));
        }
    },

    /* Given a newly received message, update the unread counter if necessary.
     * @private
     * @method _converse.ChatRoom#handleUnreadMessage
     * @param { XMLElement } - The <messsage> stanza
     */
    handleUnreadMessage (message) {
        if (!message?.get('body')) {
            return;
        }
        if (u.isNewMessage(message)) {
            if (this.isHidden()) {
                const settings = {
                    'num_unread_general': this.get('num_unread_general') + 1
                };
                if (this.get('num_unread_general') === 0) {
                    settings['first_unread_id'] = message.get('id');
                }
                if (this.isUserMentioned(message)) {
                    settings.num_unread = this.get('num_unread') + 1;
                }
                this.save(settings);
            } else {
                this.sendMarkerForMessage(message);
            }
        }
    },

    clearUnreadMsgCounter () {
        if (this.get('num_unread_general') > 0 || this.get('num_unread') > 0 || this.get('has_activity')) {
            this.sendMarkerForMessage(this.messages.last());
        }
        u.safeSave(this, {
            'has_activity': false,
            'num_unread': 0,
            'num_unread_general': 0
        });
    }
};

export default ChatRoomMixin;
