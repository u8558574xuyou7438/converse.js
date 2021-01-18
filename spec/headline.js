/*global mock, converse, _ */

describe("A headlines box", function () {

    it("will not open nor display non-headline messages",
        mock.initConverse(
            ['rosterGroupsFetched', 'chatBoxesFetched'], {}, function (done, _converse) {

        const { $msg } = converse.env;
        /* XMPP spam message:
         *
         *  <message xmlns="jabber:client"
         *          to="romeo@montague.lit"
         *          type="chat"
         *          from="gapowa20102106@rds-rostov.ru/Adium">
         *      <nick xmlns="http://jabber.org/protocol/nick">-wwdmz</nick>
         *      <body>SORRY FOR THIS ADVERT</body
         *  </message
         */
        const stanza = $msg({
                'xmlns': 'jabber:client',
                'to': 'romeo@montague.lit',
                'type': 'chat',
                'from': 'gapowa20102106@rds-rostov.ru/Adium',
            })
            .c('nick', {'xmlns': "http://jabber.org/protocol/nick"}).t("-wwdmz").up()
            .c('body').t('SORRY FOR THIS ADVERT');
        _converse.connection._dataRecv(mock.createRequest(stanza));
        expect(_converse.api.headlines.get().length === 0);
        done();
    }));

    it("will open and display headline messages", mock.initConverse(
            ['rosterGroupsFetched'], {}, async function (done, _converse) {

        const { u, $msg} = converse.env;
        /* <message from='notify.example.com'
         *          to='romeo@im.example.com'
         *          type='headline'
         *          xml:lang='en'>
         *  <subject>SIEVE</subject>
         *  <body>&lt;juliet@example.com&gt; You got mail.</body>
         *  <x xmlns='jabber:x:oob'>
         *      <url>
         *      imap://romeo@example.com/INBOX;UIDVALIDITY=385759043/;UID=18
         *      </url>
         *  </x>
         *  </message>
         */
        const stanza = $msg({
                'type': 'headline',
                'from': 'notify.example.com',
                'to': 'romeo@montague.lit',
                'xml:lang': 'en'
            })
            .c('subject').t('SIEVE').up()
            .c('body').t('&lt;juliet@example.com&gt; You got mail.').up()
            .c('x', {'xmlns': 'jabber:x:oob'})
                .c('url').t('imap://romeo@example.com/INBOX;UIDVALIDITY=385759043/;UID=18');

        _converse.connection._dataRecv(mock.createRequest(stanza));
        await u.waitUntil(() => _converse.chatboxviews.keys().includes('notify.example.com'));
        const view = _converse.chatboxviews.get('notify.example.com');
        expect(view.model.get('show_avatar')).toBeFalsy();
        expect(view.querySelector('img.avatar')).toBe(null);
        done();
    }));

    it("will show headline messages in the controlbox", mock.initConverse(
        ['rosterGroupsFetched'], {}, async function (done, _converse) {

        const { u, $msg} = converse.env;
        /* <message from='notify.example.com'
         *          to='romeo@im.example.com'
         *          type='headline'
         *          xml:lang='en'>
         *  <subject>SIEVE</subject>
         *  <body>&lt;juliet@example.com&gt; You got mail.</body>
         *  <x xmlns='jabber:x:oob'>
         *      <url>
         *      imap://romeo@example.com/INBOX;UIDVALIDITY=385759043/;UID=18
         *      </url>
         *  </x>
         *  </message>
         */
        const stanza = $msg({
                'type': 'headline',
                'from': 'notify.example.com',
                'to': 'romeo@montague.lit',
                'xml:lang': 'en'
            })
            .c('subject').t('SIEVE').up()
            .c('body').t('&lt;juliet@example.com&gt; You got mail.').up()
            .c('x', {'xmlns': 'jabber:x:oob'})
                .c('url').t('imap://romeo@example.com/INBOX;UIDVALIDITY=385759043/;UID=18');

        _converse.connection._dataRecv(mock.createRequest(stanza));
        const view = _converse.chatboxviews.get('controlbox');
        await u.waitUntil(() => view.querySelectorAll(".open-headline").length);
        expect(view.querySelectorAll('.open-headline').length).toBe(1);
        expect(view.querySelector('.open-headline').text).toBe('notify.example.com');
        done();
    }));

    it("will remove headline messages from the controlbox if closed", mock.initConverse(
        ['rosterGroupsFetched'], {}, async function (done, _converse) {

        const { u, $msg} = converse.env;
        await mock.openControlBox(_converse);
        /* <message from='notify.example.com'
         *          to='romeo@im.example.com'
         *          type='headline'
         *          xml:lang='en'>
         *  <subject>SIEVE</subject>
         *  <body>&lt;juliet@example.com&gt; You got mail.</body>
         *  <x xmlns='jabber:x:oob'>
         *      <url>
         *      imap://romeo@example.com/INBOX;UIDVALIDITY=385759043/;UID=18
         *      </url>
         *  </x>
         *  </message>
         */
        const stanza = $msg({
                'type': 'headline',
                'from': 'notify.example.com',
                'to': 'romeo@montague.lit',
                'xml:lang': 'en'
            })
            .c('subject').t('SIEVE').up()
            .c('body').t('&lt;juliet@example.com&gt; You got mail.').up()
            .c('x', {'xmlns': 'jabber:x:oob'})
                .c('url').t('imap://romeo@example.com/INBOX;UIDVALIDITY=385759043/;UID=18');

        _converse.connection._dataRecv(mock.createRequest(stanza));
        const cbview = _converse.chatboxviews.get('controlbox');
        await u.waitUntil(() => cbview.querySelectorAll(".open-headline").length);
        const hlview = _converse.chatboxviews.get('notify.example.com');
        await u.isVisible(hlview);
        const close_el = await u.waitUntil(() => hlview.querySelector('.close-chatbox-button'));
        close_el.click();
        await u.waitUntil(() => cbview.querySelectorAll(".open-headline").length === 0);
        expect(cbview.querySelectorAll('.open-headline').length).toBe(0);
        done();
    }));

    it("will not show a headline messages from a full JID if allow_non_roster_messaging is false",
        mock.initConverse(
            ['rosterGroupsFetched', 'chatBoxesFetched'], {}, function (done, _converse) {

        const { $msg } = converse.env;
        _converse.allow_non_roster_messaging = false;
        const stanza = $msg({
                'type': 'headline',
                'from': 'andre5114@jabber.snc.ru/Spark',
                'to': 'romeo@montague.lit',
                'xml:lang': 'en'
            })
            .c('nick').t('gpocy').up()
            .c('body').t('Здравствуйте друзья');
        _converse.connection._dataRecv(mock.createRequest(stanza));
        expect(_.without('controlbox', _converse.chatboxviews.keys()).length).toBe(0);
        done();
    }));
});
