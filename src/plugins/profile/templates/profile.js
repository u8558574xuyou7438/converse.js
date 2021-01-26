import { __ } from 'i18n';
import { api } from "@converse/headless/core";
import { html } from "lit-html";


export default (o) => {
    const i18n_logout = __('Log out');
    const i18n_change_status = __('Click to change your chat status');
    const i18n_details = __('Show details about this chat client');
    const show_settings_button = api.settings.get('show_client_info') || api.settings.get('allow_adhoc_commands');
    return html`
    <div class="userinfo controlbox-padded">
        <div class="controlbox-section profile d-flex">
            <a class="show-profile" href="#" @click=${o.showProfileModal}>
                <canvas class="avatar align-self-center" height="40" width="40"></canvas>
            </a>
            <span class="username w-100 align-self-center">${o.fullname}</span>
            ${show_settings_button  ? html`<a class="controlbox-heading__btn show-client-info fa fa-cog align-self-center" title="${i18n_details}" @click=${o.showUserSettingsModal}></a>` : ''}
            ${api.settings.get('allow_logout') ? html`<a class="controlbox-heading__btn logout fa fa-sign-out-alt align-self-center" title="${i18n_logout}" @click=${o.logout}></a>` : ''}
        </div>
        <div class="d-flex xmpp-status">
            <a class="change-status" title="${i18n_change_status}" data-toggle="modal" data-target="#changeStatusModal" @click=${o.showStatusChangeModal}>
                <span class="${o.chat_status} w-100 align-self-center" data-value="${o.chat_status}">
                    <span class="
                        ${o.chat_status === 'online' && 'fa fa-circle chat-status chat-status--online'}
                        ${o.chat_status === 'dnd' && 'fa fa-minus-circle chat-status chat-status--busy'}
                        ${o.chat_status === 'away' && 'fa fa-circle chat-status chat-status--away'}
                        ${o.chat_status === 'xa' && 'far fa-circle chat-status chat-status--xa '}
                        ${o.chat_status === 'offline' && 'fa fa-circle chat-status chat-status--offline'}"></span> ${o.status_message}</span>
            </a>
        </div>
    </div>
`};
