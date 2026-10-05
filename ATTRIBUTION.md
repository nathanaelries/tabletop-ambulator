# Upstream attribution

This is a local fork of [64bits/tabletop-ambulator](https://github.com/64bits/tabletop-ambulator), based on commit `860da5dd69b93a20a8825f00f85ab513310dfbe4`.

The original MIT license is preserved verbatim in `LICENSE.md`, including its original placeholder copyright line. The `upstream/` directory preserves the earlier application for reference. It is neither served by the new application nor included in the Docker image.

The fork retains Ambulator's phone-hand companion approach, TTS card/deck integration, and original companion object template. Its HTTP/WebSocket server and browser interface have been replaced to enforce sessions, private state delivery, and command authorization. No Ticket to Ride artwork, board, rules text, or Workshop game assets are bundled.
