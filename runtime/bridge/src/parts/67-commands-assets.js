  // ---------------------------------------------------------------------------
  // Commands: decoded game assets.
  //
  // The GUI slices item/skill/state icons out of the game's IconSet sheet. On
  // disk that file is often unreadable — MV encryption (.rpgmvp) or custom
  // asset protection — so this command asks the running game for the DECODED
  // sheet instead: whatever loader/decrypter pipeline the game ships with has
  // already produced plaintext pixels by the time they hit a Bitmap.
  // ---------------------------------------------------------------------------

  Object.assign(commandHandlers, {

    // Pull the decoded IconSet sheet as a data URL. Async: the image may still
    // be decoding when loadSystem returns, so poll isReady() on a deadline.
    "assets.iconset": () => {
      const imageManager = resolveImageManager();
      if (!imageManager || typeof imageManager.loadSystem !== "function") {
        throw new Error("ImageManager unavailable — not an MV/MZ game?");
      }
      let bitmap;
      try {
        bitmap = imageManager.loadSystem("IconSet");
      } catch (error) {
        throw new Error(`loadSystem("IconSet") failed: ${error.message}`);
      }
      if (!bitmap) throw new Error('loadSystem("IconSet") returned nothing');

      const deadline = Date.now() + 8000;
      return new Promise((resolve, reject) => {
        const tick = () => {
          let ready = false;
          try {
            ready = typeof bitmap.isReady === "function"
              ? bitmap.isReady()
              : !!(bitmap._image || bitmap._canvas);
          } catch (_) {}
          if (!ready) {
            if (Date.now() > deadline) {
              reject(new Error("timed out waiting for the game to decode IconSet"));
              return;
            }
            setTimeout(tick, 120);
            return;
          }
          // MV draws odd-sized images into _canvas; MZ keeps the decoded
          // HTMLImageElement in _image. Take whichever holds pixels.
          const source = (bitmap._canvas && bitmap._canvas.width) ? bitmap._canvas
            : (bitmap._image && bitmap._image.width) ? bitmap._image : null;
          if (!source) {
            reject(new Error("IconSet bitmap reports ready but has no decoded pixels"));
            return;
          }
          try {
            const canvas = document.createElement("canvas");
            canvas.width = source.width;
            canvas.height = source.height;
            canvas.getContext("2d").drawImage(source, 0, 0);
            resolve({
              dataUrl: canvas.toDataURL("image/png"),
              width: source.width,
              height: source.height
            });
          } catch (error) {
            reject(new Error(`IconSet canvas export failed: ${error.message}`));
          }
        };
        tick();
      });
    }
  });
