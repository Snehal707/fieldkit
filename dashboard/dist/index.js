/* FieldKit dashboard plugin — built from dashboard/src/index.ts. React is provided by window.__HERMES_PLUGIN_SDK__. */
(() => {
  // node_modules/qrcode-generator/dist/qrcode.mjs
  var qrcode = function(typeNumber, errorCorrectionLevel) {
    const PAD0 = 236;
    const PAD1 = 17;
    let _typeNumber = typeNumber;
    const _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
    let _modules = null;
    let _moduleCount = 0;
    let _dataCache = null;
    const _dataList = [];
    const _this = {};
    const makeImpl = function(test, maskPattern) {
      _moduleCount = _typeNumber * 4 + 17;
      _modules = (function(moduleCount) {
        const modules = new Array(moduleCount);
        for (let row = 0; row < moduleCount; row += 1) {
          modules[row] = new Array(moduleCount);
          for (let col = 0; col < moduleCount; col += 1) {
            modules[row][col] = null;
          }
        }
        return modules;
      })(_moduleCount);
      setupPositionProbePattern(0, 0);
      setupPositionProbePattern(_moduleCount - 7, 0);
      setupPositionProbePattern(0, _moduleCount - 7);
      setupPositionAdjustPattern();
      setupTimingPattern();
      setupTypeInfo(test, maskPattern);
      if (_typeNumber >= 7) {
        setupTypeNumber(test);
      }
      if (_dataCache == null) {
        _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
      }
      mapData(_dataCache, maskPattern);
    };
    const setupPositionProbePattern = function(row, col) {
      for (let r = -1; r <= 7; r += 1) {
        if (row + r <= -1 || _moduleCount <= row + r) continue;
        for (let c = -1; c <= 7; c += 1) {
          if (col + c <= -1 || _moduleCount <= col + c) continue;
          if (0 <= r && r <= 6 && (c == 0 || c == 6) || 0 <= c && c <= 6 && (r == 0 || r == 6) || 2 <= r && r <= 4 && 2 <= c && c <= 4) {
            _modules[row + r][col + c] = true;
          } else {
            _modules[row + r][col + c] = false;
          }
        }
      }
    };
    const getBestMaskPattern = function() {
      let minLostPoint = 0;
      let pattern = 0;
      for (let i = 0; i < 8; i += 1) {
        makeImpl(true, i);
        const lostPoint = QRUtil.getLostPoint(_this);
        if (i == 0 || minLostPoint > lostPoint) {
          minLostPoint = lostPoint;
          pattern = i;
        }
      }
      return pattern;
    };
    const setupTimingPattern = function() {
      for (let r = 8; r < _moduleCount - 8; r += 1) {
        if (_modules[r][6] != null) {
          continue;
        }
        _modules[r][6] = r % 2 == 0;
      }
      for (let c = 8; c < _moduleCount - 8; c += 1) {
        if (_modules[6][c] != null) {
          continue;
        }
        _modules[6][c] = c % 2 == 0;
      }
    };
    const setupPositionAdjustPattern = function() {
      const pos = QRUtil.getPatternPosition(_typeNumber);
      for (let i = 0; i < pos.length; i += 1) {
        for (let j = 0; j < pos.length; j += 1) {
          const row = pos[i];
          const col = pos[j];
          if (_modules[row][col] != null) {
            continue;
          }
          for (let r = -2; r <= 2; r += 1) {
            for (let c = -2; c <= 2; c += 1) {
              if (r == -2 || r == 2 || c == -2 || c == 2 || r == 0 && c == 0) {
                _modules[row + r][col + c] = true;
              } else {
                _modules[row + r][col + c] = false;
              }
            }
          }
        }
      }
    };
    const setupTypeNumber = function(test) {
      const bits = QRUtil.getBCHTypeNumber(_typeNumber);
      for (let i = 0; i < 18; i += 1) {
        const mod = !test && (bits >> i & 1) == 1;
        _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
      }
      for (let i = 0; i < 18; i += 1) {
        const mod = !test && (bits >> i & 1) == 1;
        _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
      }
    };
    const setupTypeInfo = function(test, maskPattern) {
      const data = _errorCorrectionLevel << 3 | maskPattern;
      const bits = QRUtil.getBCHTypeInfo(data);
      for (let i = 0; i < 15; i += 1) {
        const mod = !test && (bits >> i & 1) == 1;
        if (i < 6) {
          _modules[i][8] = mod;
        } else if (i < 8) {
          _modules[i + 1][8] = mod;
        } else {
          _modules[_moduleCount - 15 + i][8] = mod;
        }
      }
      for (let i = 0; i < 15; i += 1) {
        const mod = !test && (bits >> i & 1) == 1;
        if (i < 8) {
          _modules[8][_moduleCount - i - 1] = mod;
        } else if (i < 9) {
          _modules[8][15 - i - 1 + 1] = mod;
        } else {
          _modules[8][15 - i - 1] = mod;
        }
      }
      _modules[_moduleCount - 8][8] = !test;
    };
    const mapData = function(data, maskPattern) {
      let inc = -1;
      let row = _moduleCount - 1;
      let bitIndex = 7;
      let byteIndex = 0;
      const maskFunc = QRUtil.getMaskFunction(maskPattern);
      for (let col = _moduleCount - 1; col > 0; col -= 2) {
        if (col == 6) col -= 1;
        while (true) {
          for (let c = 0; c < 2; c += 1) {
            if (_modules[row][col - c] == null) {
              let dark = false;
              if (byteIndex < data.length) {
                dark = (data[byteIndex] >>> bitIndex & 1) == 1;
              }
              const mask = maskFunc(row, col - c);
              if (mask) {
                dark = !dark;
              }
              _modules[row][col - c] = dark;
              bitIndex -= 1;
              if (bitIndex == -1) {
                byteIndex += 1;
                bitIndex = 7;
              }
            }
          }
          row += inc;
          if (row < 0 || _moduleCount <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    };
    const createBytes = function(buffer, rsBlocks) {
      let offset = 0;
      let maxDcCount = 0;
      let maxEcCount = 0;
      const dcdata = new Array(rsBlocks.length);
      const ecdata = new Array(rsBlocks.length);
      for (let r = 0; r < rsBlocks.length; r += 1) {
        const dcCount = rsBlocks[r].dataCount;
        const ecCount = rsBlocks[r].totalCount - dcCount;
        maxDcCount = Math.max(maxDcCount, dcCount);
        maxEcCount = Math.max(maxEcCount, ecCount);
        dcdata[r] = new Array(dcCount);
        for (let i = 0; i < dcdata[r].length; i += 1) {
          dcdata[r][i] = 255 & buffer.getBuffer()[i + offset];
        }
        offset += dcCount;
        const rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
        const rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);
        const modPoly = rawPoly.mod(rsPoly);
        ecdata[r] = new Array(rsPoly.getLength() - 1);
        for (let i = 0; i < ecdata[r].length; i += 1) {
          const modIndex = i + modPoly.getLength() - ecdata[r].length;
          ecdata[r][i] = modIndex >= 0 ? modPoly.getAt(modIndex) : 0;
        }
      }
      let totalCodeCount = 0;
      for (let i = 0; i < rsBlocks.length; i += 1) {
        totalCodeCount += rsBlocks[i].totalCount;
      }
      const data = new Array(totalCodeCount);
      let index = 0;
      for (let i = 0; i < maxDcCount; i += 1) {
        for (let r = 0; r < rsBlocks.length; r += 1) {
          if (i < dcdata[r].length) {
            data[index] = dcdata[r][i];
            index += 1;
          }
        }
      }
      for (let i = 0; i < maxEcCount; i += 1) {
        for (let r = 0; r < rsBlocks.length; r += 1) {
          if (i < ecdata[r].length) {
            data[index] = ecdata[r][i];
            index += 1;
          }
        }
      }
      return data;
    };
    const createData = function(typeNumber2, errorCorrectionLevel2, dataList) {
      const rsBlocks = QRRSBlock.getRSBlocks(typeNumber2, errorCorrectionLevel2);
      const buffer = qrBitBuffer();
      for (let i = 0; i < dataList.length; i += 1) {
        const data = dataList[i];
        buffer.put(data.getMode(), 4);
        buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber2));
        data.write(buffer);
      }
      let totalDataCount = 0;
      for (let i = 0; i < rsBlocks.length; i += 1) {
        totalDataCount += rsBlocks[i].dataCount;
      }
      if (buffer.getLengthInBits() > totalDataCount * 8) {
        throw "code length overflow. (" + buffer.getLengthInBits() + ">" + totalDataCount * 8 + ")";
      }
      if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
        buffer.put(0, 4);
      }
      while (buffer.getLengthInBits() % 8 != 0) {
        buffer.putBit(false);
      }
      while (true) {
        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD0, 8);
        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD1, 8);
      }
      return createBytes(buffer, rsBlocks);
    };
    _this.addData = function(data, mode) {
      mode = mode || "Byte";
      let newData = null;
      switch (mode) {
        case "Numeric":
          newData = qrNumber(data);
          break;
        case "Alphanumeric":
          newData = qrAlphaNum(data);
          break;
        case "Byte":
          newData = qr8BitByte(data);
          break;
        case "Kanji":
          newData = qrKanji(data);
          break;
        default:
          throw "mode:" + mode;
      }
      _dataList.push(newData);
      _dataCache = null;
    };
    _this.isDark = function(row, col) {
      if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
        throw row + "," + col;
      }
      return _modules[row][col];
    };
    _this.getModuleCount = function() {
      return _moduleCount;
    };
    _this.make = function() {
      if (_typeNumber < 1) {
        let typeNumber2 = 1;
        for (; typeNumber2 < 40; typeNumber2++) {
          const rsBlocks = QRRSBlock.getRSBlocks(typeNumber2, _errorCorrectionLevel);
          const buffer = qrBitBuffer();
          for (let i = 0; i < _dataList.length; i++) {
            const data = _dataList[i];
            buffer.put(data.getMode(), 4);
            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber2));
            data.write(buffer);
          }
          let totalDataCount = 0;
          for (let i = 0; i < rsBlocks.length; i++) {
            totalDataCount += rsBlocks[i].dataCount;
          }
          if (buffer.getLengthInBits() <= totalDataCount * 8) {
            break;
          }
        }
        _typeNumber = typeNumber2;
      }
      makeImpl(false, getBestMaskPattern());
    };
    _this.createTableTag = function(cellSize, margin) {
      cellSize = cellSize || 2;
      margin = typeof margin == "undefined" ? cellSize * 4 : margin;
      let qrHtml = "";
      qrHtml += '<table style="';
      qrHtml += " border-width: 0px; border-style: none;";
      qrHtml += " border-collapse: collapse;";
      qrHtml += " padding: 0px; margin: " + margin + "px;";
      qrHtml += '">';
      qrHtml += "<tbody>";
      for (let r = 0; r < _this.getModuleCount(); r += 1) {
        qrHtml += "<tr>";
        for (let c = 0; c < _this.getModuleCount(); c += 1) {
          qrHtml += '<td style="';
          qrHtml += " border-width: 0px; border-style: none;";
          qrHtml += " border-collapse: collapse;";
          qrHtml += " padding: 0px; margin: 0px;";
          qrHtml += " width: " + cellSize + "px;";
          qrHtml += " height: " + cellSize + "px;";
          qrHtml += " background-color: ";
          qrHtml += _this.isDark(r, c) ? "#000000" : "#ffffff";
          qrHtml += ";";
          qrHtml += '"/>';
        }
        qrHtml += "</tr>";
      }
      qrHtml += "</tbody>";
      qrHtml += "</table>";
      return qrHtml;
    };
    _this.createSvgTag = function(cellSize, margin, alt, title) {
      let opts = {};
      if (typeof arguments[0] == "object") {
        opts = arguments[0];
        cellSize = opts.cellSize;
        margin = opts.margin;
        alt = opts.alt;
        title = opts.title;
      }
      cellSize = cellSize || 2;
      margin = typeof margin == "undefined" ? cellSize * 4 : margin;
      alt = typeof alt === "string" ? { text: alt } : alt || {};
      alt.text = alt.text || null;
      alt.id = alt.text ? alt.id || "qrcode-description" : null;
      title = typeof title === "string" ? { text: title } : title || {};
      title.text = title.text || null;
      title.id = title.text ? title.id || "qrcode-title" : null;
      const size = _this.getModuleCount() * cellSize + margin * 2;
      let c, mc, r, mr, qrSvg = "", rect;
      rect = "l" + cellSize + ",0 0," + cellSize + " -" + cellSize + ",0 0,-" + cellSize + "z ";
      qrSvg += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
      qrSvg += !opts.scalable ? ' width="' + size + 'px" height="' + size + 'px"' : "";
      qrSvg += ' viewBox="0 0 ' + size + " " + size + '" ';
      qrSvg += ' preserveAspectRatio="xMinYMin meet"';
      qrSvg += title.text || alt.text ? ' role="img" aria-labelledby="' + escapeXml([title.id, alt.id].join(" ").trim()) + '"' : "";
      qrSvg += ">";
      qrSvg += title.text ? '<title id="' + escapeXml(title.id) + '">' + escapeXml(title.text) + "</title>" : "";
      qrSvg += alt.text ? '<description id="' + escapeXml(alt.id) + '">' + escapeXml(alt.text) + "</description>" : "";
      qrSvg += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
      qrSvg += '<path d="';
      for (r = 0; r < _this.getModuleCount(); r += 1) {
        mr = r * cellSize + margin;
        for (c = 0; c < _this.getModuleCount(); c += 1) {
          if (_this.isDark(r, c)) {
            mc = c * cellSize + margin;
            qrSvg += "M" + mc + "," + mr + rect;
          }
        }
      }
      qrSvg += '" stroke="transparent" fill="black"/>';
      qrSvg += "</svg>";
      return qrSvg;
    };
    _this.createDataURL = function(cellSize, margin) {
      cellSize = cellSize || 2;
      margin = typeof margin == "undefined" ? cellSize * 4 : margin;
      const size = _this.getModuleCount() * cellSize + margin * 2;
      const min = margin;
      const max = size - margin;
      return createDataURL(size, size, function(x, y) {
        if (min <= x && x < max && min <= y && y < max) {
          const c = Math.floor((x - min) / cellSize);
          const r = Math.floor((y - min) / cellSize);
          return _this.isDark(r, c) ? 0 : 1;
        } else {
          return 1;
        }
      });
    };
    _this.createImgTag = function(cellSize, margin, alt) {
      cellSize = cellSize || 2;
      margin = typeof margin == "undefined" ? cellSize * 4 : margin;
      const size = _this.getModuleCount() * cellSize + margin * 2;
      let img = "";
      img += "<img";
      img += ' src="';
      img += _this.createDataURL(cellSize, margin);
      img += '"';
      img += ' width="';
      img += size;
      img += '"';
      img += ' height="';
      img += size;
      img += '"';
      if (alt) {
        img += ' alt="';
        img += escapeXml(alt);
        img += '"';
      }
      img += "/>";
      return img;
    };
    const escapeXml = function(s) {
      let escaped = "";
      for (let i = 0; i < s.length; i += 1) {
        const c = s.charAt(i);
        switch (c) {
          case "<":
            escaped += "&lt;";
            break;
          case ">":
            escaped += "&gt;";
            break;
          case "&":
            escaped += "&amp;";
            break;
          case '"':
            escaped += "&quot;";
            break;
          default:
            escaped += c;
            break;
        }
      }
      return escaped;
    };
    const _createHalfASCII = function(margin) {
      const cellSize = 1;
      margin = typeof margin == "undefined" ? cellSize * 2 : margin;
      const size = _this.getModuleCount() * cellSize + margin * 2;
      const min = margin;
      const max = size - margin;
      let y, x, r1, r2, p;
      const blocks = {
        "\u2588\u2588": "\u2588",
        "\u2588 ": "\u2580",
        " \u2588": "\u2584",
        "  ": " "
      };
      const blocksLastLineNoMargin = {
        "\u2588\u2588": "\u2580",
        "\u2588 ": "\u2580",
        " \u2588": " ",
        "  ": " "
      };
      let ascii = "";
      for (y = 0; y < size; y += 2) {
        r1 = Math.floor((y - min) / cellSize);
        r2 = Math.floor((y + 1 - min) / cellSize);
        for (x = 0; x < size; x += 1) {
          p = "\u2588";
          if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {
            p = " ";
          }
          if (min <= x && x < max && min <= y + 1 && y + 1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {
            p += " ";
          } else {
            p += "\u2588";
          }
          ascii += margin < 1 && y + 1 >= max ? blocksLastLineNoMargin[p] : blocks[p];
        }
        ascii += "\n";
      }
      if (size % 2 && margin > 0) {
        return ascii.substring(0, ascii.length - size - 1) + Array(size + 1).join("\u2580");
      }
      return ascii.substring(0, ascii.length - 1);
    };
    _this.createASCII = function(cellSize, margin) {
      cellSize = cellSize || 1;
      if (cellSize < 2) {
        return _createHalfASCII(margin);
      }
      cellSize -= 1;
      margin = typeof margin == "undefined" ? cellSize * 2 : margin;
      const size = _this.getModuleCount() * cellSize + margin * 2;
      const min = margin;
      const max = size - margin;
      let y, x, r, p;
      const white = Array(cellSize + 1).join("\u2588\u2588");
      const black = Array(cellSize + 1).join("  ");
      let ascii = "";
      let line = "";
      for (y = 0; y < size; y += 1) {
        r = Math.floor((y - min) / cellSize);
        line = "";
        for (x = 0; x < size; x += 1) {
          p = 1;
          if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {
            p = 0;
          }
          line += p ? white : black;
        }
        for (r = 0; r < cellSize; r += 1) {
          ascii += line + "\n";
        }
      }
      return ascii.substring(0, ascii.length - 1);
    };
    _this.renderTo2dContext = function(context, cellSize) {
      cellSize = cellSize || 2;
      const length = _this.getModuleCount();
      for (let row = 0; row < length; row++) {
        for (let col = 0; col < length; col++) {
          context.fillStyle = _this.isDark(row, col) ? "black" : "white";
          context.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
        }
      }
    };
    return _this;
  };
  qrcode.stringToBytes = function(s) {
    const bytes = [];
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      bytes.push(c & 255);
    }
    return bytes;
  };
  qrcode.createStringToBytes = function(unicodeData, numChars) {
    const unicodeMap = (function() {
      const bin = base64DecodeInputStream(unicodeData);
      const read = function() {
        const b = bin.read();
        if (b == -1) throw "eof";
        return b;
      };
      let count = 0;
      const unicodeMap2 = {};
      while (true) {
        const b0 = bin.read();
        if (b0 == -1) break;
        const b1 = read();
        const b2 = read();
        const b3 = read();
        const k = String.fromCharCode(b0 << 8 | b1);
        const v = b2 << 8 | b3;
        unicodeMap2[k] = v;
        count += 1;
      }
      if (count != numChars) {
        throw count + " != " + numChars;
      }
      return unicodeMap2;
    })();
    const unknownChar = "?".charCodeAt(0);
    return function(s) {
      const bytes = [];
      for (let i = 0; i < s.length; i += 1) {
        const c = s.charCodeAt(i);
        if (c < 128) {
          bytes.push(c);
        } else {
          const b = unicodeMap[s.charAt(i)];
          if (typeof b == "number") {
            if ((b & 255) == b) {
              bytes.push(b);
            } else {
              bytes.push(b >>> 8);
              bytes.push(b & 255);
            }
          } else {
            bytes.push(unknownChar);
          }
        }
      }
      return bytes;
    };
  };
  var QRMode = {
    MODE_NUMBER: 1 << 0,
    MODE_ALPHA_NUM: 1 << 1,
    MODE_8BIT_BYTE: 1 << 2,
    MODE_KANJI: 1 << 3
  };
  var QRErrorCorrectionLevel = {
    L: 1,
    M: 0,
    Q: 3,
    H: 2
  };
  var QRMaskPattern = {
    PATTERN000: 0,
    PATTERN001: 1,
    PATTERN010: 2,
    PATTERN011: 3,
    PATTERN100: 4,
    PATTERN101: 5,
    PATTERN110: 6,
    PATTERN111: 7
  };
  var QRUtil = (function() {
    const PATTERN_POSITION_TABLE = [
      [],
      [6, 18],
      [6, 22],
      [6, 26],
      [6, 30],
      [6, 34],
      [6, 22, 38],
      [6, 24, 42],
      [6, 26, 46],
      [6, 28, 50],
      [6, 30, 54],
      [6, 32, 58],
      [6, 34, 62],
      [6, 26, 46, 66],
      [6, 26, 48, 70],
      [6, 26, 50, 74],
      [6, 30, 54, 78],
      [6, 30, 56, 82],
      [6, 30, 58, 86],
      [6, 34, 62, 90],
      [6, 28, 50, 72, 94],
      [6, 26, 50, 74, 98],
      [6, 30, 54, 78, 102],
      [6, 28, 54, 80, 106],
      [6, 32, 58, 84, 110],
      [6, 30, 58, 86, 114],
      [6, 34, 62, 90, 118],
      [6, 26, 50, 74, 98, 122],
      [6, 30, 54, 78, 102, 126],
      [6, 26, 52, 78, 104, 130],
      [6, 30, 56, 82, 108, 134],
      [6, 34, 60, 86, 112, 138],
      [6, 30, 58, 86, 114, 142],
      [6, 34, 62, 90, 118, 146],
      [6, 30, 54, 78, 102, 126, 150],
      [6, 24, 50, 76, 102, 128, 154],
      [6, 28, 54, 80, 106, 132, 158],
      [6, 32, 58, 84, 110, 136, 162],
      [6, 26, 54, 82, 110, 138, 166],
      [6, 30, 58, 86, 114, 142, 170]
    ];
    const G15 = 1 << 10 | 1 << 8 | 1 << 5 | 1 << 4 | 1 << 2 | 1 << 1 | 1 << 0;
    const G18 = 1 << 12 | 1 << 11 | 1 << 10 | 1 << 9 | 1 << 8 | 1 << 5 | 1 << 2 | 1 << 0;
    const G15_MASK = 1 << 14 | 1 << 12 | 1 << 10 | 1 << 4 | 1 << 1;
    const _this = {};
    const getBCHDigit = function(data) {
      let digit = 0;
      while (data != 0) {
        digit += 1;
        data >>>= 1;
      }
      return digit;
    };
    _this.getBCHTypeInfo = function(data) {
      let d = data << 10;
      while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
        d ^= G15 << getBCHDigit(d) - getBCHDigit(G15);
      }
      return (data << 10 | d) ^ G15_MASK;
    };
    _this.getBCHTypeNumber = function(data) {
      let d = data << 12;
      while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
        d ^= G18 << getBCHDigit(d) - getBCHDigit(G18);
      }
      return data << 12 | d;
    };
    _this.getPatternPosition = function(typeNumber) {
      return PATTERN_POSITION_TABLE[typeNumber - 1];
    };
    _this.getMaskFunction = function(maskPattern) {
      switch (maskPattern) {
        case QRMaskPattern.PATTERN000:
          return function(i, j) {
            return (i + j) % 2 == 0;
          };
        case QRMaskPattern.PATTERN001:
          return function(i, j) {
            return i % 2 == 0;
          };
        case QRMaskPattern.PATTERN010:
          return function(i, j) {
            return j % 3 == 0;
          };
        case QRMaskPattern.PATTERN011:
          return function(i, j) {
            return (i + j) % 3 == 0;
          };
        case QRMaskPattern.PATTERN100:
          return function(i, j) {
            return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 == 0;
          };
        case QRMaskPattern.PATTERN101:
          return function(i, j) {
            return i * j % 2 + i * j % 3 == 0;
          };
        case QRMaskPattern.PATTERN110:
          return function(i, j) {
            return (i * j % 2 + i * j % 3) % 2 == 0;
          };
        case QRMaskPattern.PATTERN111:
          return function(i, j) {
            return (i * j % 3 + (i + j) % 2) % 2 == 0;
          };
        default:
          throw "bad maskPattern:" + maskPattern;
      }
    };
    _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
      let a = qrPolynomial([1], 0);
      for (let i = 0; i < errorCorrectLength; i += 1) {
        a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0));
      }
      return a;
    };
    _this.getLengthInBits = function(mode, type) {
      if (1 <= type && type < 10) {
        switch (mode) {
          case QRMode.MODE_NUMBER:
            return 10;
          case QRMode.MODE_ALPHA_NUM:
            return 9;
          case QRMode.MODE_8BIT_BYTE:
            return 8;
          case QRMode.MODE_KANJI:
            return 8;
          default:
            throw "mode:" + mode;
        }
      } else if (type < 27) {
        switch (mode) {
          case QRMode.MODE_NUMBER:
            return 12;
          case QRMode.MODE_ALPHA_NUM:
            return 11;
          case QRMode.MODE_8BIT_BYTE:
            return 16;
          case QRMode.MODE_KANJI:
            return 10;
          default:
            throw "mode:" + mode;
        }
      } else if (type < 41) {
        switch (mode) {
          case QRMode.MODE_NUMBER:
            return 14;
          case QRMode.MODE_ALPHA_NUM:
            return 13;
          case QRMode.MODE_8BIT_BYTE:
            return 16;
          case QRMode.MODE_KANJI:
            return 12;
          default:
            throw "mode:" + mode;
        }
      } else {
        throw "type:" + type;
      }
    };
    _this.getLostPoint = function(qrcode2) {
      const moduleCount = qrcode2.getModuleCount();
      let lostPoint = 0;
      for (let row = 0; row < moduleCount; row += 1) {
        for (let col = 0; col < moduleCount; col += 1) {
          let sameCount = 0;
          const dark = qrcode2.isDark(row, col);
          for (let r = -1; r <= 1; r += 1) {
            if (row + r < 0 || moduleCount <= row + r) {
              continue;
            }
            for (let c = -1; c <= 1; c += 1) {
              if (col + c < 0 || moduleCount <= col + c) {
                continue;
              }
              if (r == 0 && c == 0) {
                continue;
              }
              if (dark == qrcode2.isDark(row + r, col + c)) {
                sameCount += 1;
              }
            }
          }
          if (sameCount > 5) {
            lostPoint += 3 + sameCount - 5;
          }
        }
      }
      ;
      for (let row = 0; row < moduleCount - 1; row += 1) {
        for (let col = 0; col < moduleCount - 1; col += 1) {
          let count = 0;
          if (qrcode2.isDark(row, col)) count += 1;
          if (qrcode2.isDark(row + 1, col)) count += 1;
          if (qrcode2.isDark(row, col + 1)) count += 1;
          if (qrcode2.isDark(row + 1, col + 1)) count += 1;
          if (count == 0 || count == 4) {
            lostPoint += 3;
          }
        }
      }
      for (let row = 0; row < moduleCount; row += 1) {
        for (let col = 0; col < moduleCount - 6; col += 1) {
          if (qrcode2.isDark(row, col) && !qrcode2.isDark(row, col + 1) && qrcode2.isDark(row, col + 2) && qrcode2.isDark(row, col + 3) && qrcode2.isDark(row, col + 4) && !qrcode2.isDark(row, col + 5) && qrcode2.isDark(row, col + 6)) {
            lostPoint += 40;
          }
        }
      }
      for (let col = 0; col < moduleCount; col += 1) {
        for (let row = 0; row < moduleCount - 6; row += 1) {
          if (qrcode2.isDark(row, col) && !qrcode2.isDark(row + 1, col) && qrcode2.isDark(row + 2, col) && qrcode2.isDark(row + 3, col) && qrcode2.isDark(row + 4, col) && !qrcode2.isDark(row + 5, col) && qrcode2.isDark(row + 6, col)) {
            lostPoint += 40;
          }
        }
      }
      let darkCount = 0;
      for (let col = 0; col < moduleCount; col += 1) {
        for (let row = 0; row < moduleCount; row += 1) {
          if (qrcode2.isDark(row, col)) {
            darkCount += 1;
          }
        }
      }
      const ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
      lostPoint += ratio * 10;
      return lostPoint;
    };
    return _this;
  })();
  var QRMath = (function() {
    const EXP_TABLE = new Array(256);
    const LOG_TABLE = new Array(256);
    for (let i = 0; i < 8; i += 1) {
      EXP_TABLE[i] = 1 << i;
    }
    for (let i = 8; i < 256; i += 1) {
      EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8];
    }
    for (let i = 0; i < 255; i += 1) {
      LOG_TABLE[EXP_TABLE[i]] = i;
    }
    const _this = {};
    _this.glog = function(n) {
      if (n < 1) {
        throw "glog(" + n + ")";
      }
      return LOG_TABLE[n];
    };
    _this.gexp = function(n) {
      while (n < 0) {
        n += 255;
      }
      while (n >= 256) {
        n -= 255;
      }
      return EXP_TABLE[n];
    };
    return _this;
  })();
  var qrPolynomial = function(num, shift) {
    if (typeof num.length == "undefined") {
      throw num.length + "/" + shift;
    }
    const _num = (function() {
      let offset = 0;
      while (offset < num.length && num[offset] == 0) {
        offset += 1;
      }
      const _num2 = new Array(num.length - offset + shift);
      for (let i = 0; i < num.length - offset; i += 1) {
        _num2[i] = num[i + offset];
      }
      return _num2;
    })();
    const _this = {};
    _this.getAt = function(index) {
      return _num[index];
    };
    _this.getLength = function() {
      return _num.length;
    };
    _this.multiply = function(e) {
      const num2 = new Array(_this.getLength() + e.getLength() - 1);
      for (let i = 0; i < _this.getLength(); i += 1) {
        for (let j = 0; j < e.getLength(); j += 1) {
          num2[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i)) + QRMath.glog(e.getAt(j)));
        }
      }
      return qrPolynomial(num2, 0);
    };
    _this.mod = function(e) {
      if (_this.getLength() - e.getLength() < 0) {
        return _this;
      }
      const ratio = QRMath.glog(_this.getAt(0)) - QRMath.glog(e.getAt(0));
      const num2 = new Array(_this.getLength());
      for (let i = 0; i < _this.getLength(); i += 1) {
        num2[i] = _this.getAt(i);
      }
      for (let i = 0; i < e.getLength(); i += 1) {
        num2[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i)) + ratio);
      }
      return qrPolynomial(num2, 0).mod(e);
    };
    return _this;
  };
  var QRRSBlock = (function() {
    const RS_BLOCK_TABLE = [
      // L
      // M
      // Q
      // H
      // 1
      [1, 26, 19],
      [1, 26, 16],
      [1, 26, 13],
      [1, 26, 9],
      // 2
      [1, 44, 34],
      [1, 44, 28],
      [1, 44, 22],
      [1, 44, 16],
      // 3
      [1, 70, 55],
      [1, 70, 44],
      [2, 35, 17],
      [2, 35, 13],
      // 4
      [1, 100, 80],
      [2, 50, 32],
      [2, 50, 24],
      [4, 25, 9],
      // 5
      [1, 134, 108],
      [2, 67, 43],
      [2, 33, 15, 2, 34, 16],
      [2, 33, 11, 2, 34, 12],
      // 6
      [2, 86, 68],
      [4, 43, 27],
      [4, 43, 19],
      [4, 43, 15],
      // 7
      [2, 98, 78],
      [4, 49, 31],
      [2, 32, 14, 4, 33, 15],
      [4, 39, 13, 1, 40, 14],
      // 8
      [2, 121, 97],
      [2, 60, 38, 2, 61, 39],
      [4, 40, 18, 2, 41, 19],
      [4, 40, 14, 2, 41, 15],
      // 9
      [2, 146, 116],
      [3, 58, 36, 2, 59, 37],
      [4, 36, 16, 4, 37, 17],
      [4, 36, 12, 4, 37, 13],
      // 10
      [2, 86, 68, 2, 87, 69],
      [4, 69, 43, 1, 70, 44],
      [6, 43, 19, 2, 44, 20],
      [6, 43, 15, 2, 44, 16],
      // 11
      [4, 101, 81],
      [1, 80, 50, 4, 81, 51],
      [4, 50, 22, 4, 51, 23],
      [3, 36, 12, 8, 37, 13],
      // 12
      [2, 116, 92, 2, 117, 93],
      [6, 58, 36, 2, 59, 37],
      [4, 46, 20, 6, 47, 21],
      [7, 42, 14, 4, 43, 15],
      // 13
      [4, 133, 107],
      [8, 59, 37, 1, 60, 38],
      [8, 44, 20, 4, 45, 21],
      [12, 33, 11, 4, 34, 12],
      // 14
      [3, 145, 115, 1, 146, 116],
      [4, 64, 40, 5, 65, 41],
      [11, 36, 16, 5, 37, 17],
      [11, 36, 12, 5, 37, 13],
      // 15
      [5, 109, 87, 1, 110, 88],
      [5, 65, 41, 5, 66, 42],
      [5, 54, 24, 7, 55, 25],
      [11, 36, 12, 7, 37, 13],
      // 16
      [5, 122, 98, 1, 123, 99],
      [7, 73, 45, 3, 74, 46],
      [15, 43, 19, 2, 44, 20],
      [3, 45, 15, 13, 46, 16],
      // 17
      [1, 135, 107, 5, 136, 108],
      [10, 74, 46, 1, 75, 47],
      [1, 50, 22, 15, 51, 23],
      [2, 42, 14, 17, 43, 15],
      // 18
      [5, 150, 120, 1, 151, 121],
      [9, 69, 43, 4, 70, 44],
      [17, 50, 22, 1, 51, 23],
      [2, 42, 14, 19, 43, 15],
      // 19
      [3, 141, 113, 4, 142, 114],
      [3, 70, 44, 11, 71, 45],
      [17, 47, 21, 4, 48, 22],
      [9, 39, 13, 16, 40, 14],
      // 20
      [3, 135, 107, 5, 136, 108],
      [3, 67, 41, 13, 68, 42],
      [15, 54, 24, 5, 55, 25],
      [15, 43, 15, 10, 44, 16],
      // 21
      [4, 144, 116, 4, 145, 117],
      [17, 68, 42],
      [17, 50, 22, 6, 51, 23],
      [19, 46, 16, 6, 47, 17],
      // 22
      [2, 139, 111, 7, 140, 112],
      [17, 74, 46],
      [7, 54, 24, 16, 55, 25],
      [34, 37, 13],
      // 23
      [4, 151, 121, 5, 152, 122],
      [4, 75, 47, 14, 76, 48],
      [11, 54, 24, 14, 55, 25],
      [16, 45, 15, 14, 46, 16],
      // 24
      [6, 147, 117, 4, 148, 118],
      [6, 73, 45, 14, 74, 46],
      [11, 54, 24, 16, 55, 25],
      [30, 46, 16, 2, 47, 17],
      // 25
      [8, 132, 106, 4, 133, 107],
      [8, 75, 47, 13, 76, 48],
      [7, 54, 24, 22, 55, 25],
      [22, 45, 15, 13, 46, 16],
      // 26
      [10, 142, 114, 2, 143, 115],
      [19, 74, 46, 4, 75, 47],
      [28, 50, 22, 6, 51, 23],
      [33, 46, 16, 4, 47, 17],
      // 27
      [8, 152, 122, 4, 153, 123],
      [22, 73, 45, 3, 74, 46],
      [8, 53, 23, 26, 54, 24],
      [12, 45, 15, 28, 46, 16],
      // 28
      [3, 147, 117, 10, 148, 118],
      [3, 73, 45, 23, 74, 46],
      [4, 54, 24, 31, 55, 25],
      [11, 45, 15, 31, 46, 16],
      // 29
      [7, 146, 116, 7, 147, 117],
      [21, 73, 45, 7, 74, 46],
      [1, 53, 23, 37, 54, 24],
      [19, 45, 15, 26, 46, 16],
      // 30
      [5, 145, 115, 10, 146, 116],
      [19, 75, 47, 10, 76, 48],
      [15, 54, 24, 25, 55, 25],
      [23, 45, 15, 25, 46, 16],
      // 31
      [13, 145, 115, 3, 146, 116],
      [2, 74, 46, 29, 75, 47],
      [42, 54, 24, 1, 55, 25],
      [23, 45, 15, 28, 46, 16],
      // 32
      [17, 145, 115],
      [10, 74, 46, 23, 75, 47],
      [10, 54, 24, 35, 55, 25],
      [19, 45, 15, 35, 46, 16],
      // 33
      [17, 145, 115, 1, 146, 116],
      [14, 74, 46, 21, 75, 47],
      [29, 54, 24, 19, 55, 25],
      [11, 45, 15, 46, 46, 16],
      // 34
      [13, 145, 115, 6, 146, 116],
      [14, 74, 46, 23, 75, 47],
      [44, 54, 24, 7, 55, 25],
      [59, 46, 16, 1, 47, 17],
      // 35
      [12, 151, 121, 7, 152, 122],
      [12, 75, 47, 26, 76, 48],
      [39, 54, 24, 14, 55, 25],
      [22, 45, 15, 41, 46, 16],
      // 36
      [6, 151, 121, 14, 152, 122],
      [6, 75, 47, 34, 76, 48],
      [46, 54, 24, 10, 55, 25],
      [2, 45, 15, 64, 46, 16],
      // 37
      [17, 152, 122, 4, 153, 123],
      [29, 74, 46, 14, 75, 47],
      [49, 54, 24, 10, 55, 25],
      [24, 45, 15, 46, 46, 16],
      // 38
      [4, 152, 122, 18, 153, 123],
      [13, 74, 46, 32, 75, 47],
      [48, 54, 24, 14, 55, 25],
      [42, 45, 15, 32, 46, 16],
      // 39
      [20, 147, 117, 4, 148, 118],
      [40, 75, 47, 7, 76, 48],
      [43, 54, 24, 22, 55, 25],
      [10, 45, 15, 67, 46, 16],
      // 40
      [19, 148, 118, 6, 149, 119],
      [18, 75, 47, 31, 76, 48],
      [34, 54, 24, 34, 55, 25],
      [20, 45, 15, 61, 46, 16]
    ];
    const qrRSBlock = function(totalCount, dataCount) {
      const _this2 = {};
      _this2.totalCount = totalCount;
      _this2.dataCount = dataCount;
      return _this2;
    };
    const _this = {};
    const getRsBlockTable = function(typeNumber, errorCorrectionLevel) {
      switch (errorCorrectionLevel) {
        case QRErrorCorrectionLevel.L:
          return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
        case QRErrorCorrectionLevel.M:
          return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
        case QRErrorCorrectionLevel.Q:
          return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
        case QRErrorCorrectionLevel.H:
          return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
        default:
          return void 0;
      }
    };
    _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {
      const rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);
      if (typeof rsBlock == "undefined") {
        throw "bad rs block @ typeNumber:" + typeNumber + "/errorCorrectionLevel:" + errorCorrectionLevel;
      }
      const length = rsBlock.length / 3;
      const list = [];
      for (let i = 0; i < length; i += 1) {
        const count = rsBlock[i * 3 + 0];
        const totalCount = rsBlock[i * 3 + 1];
        const dataCount = rsBlock[i * 3 + 2];
        for (let j = 0; j < count; j += 1) {
          list.push(qrRSBlock(totalCount, dataCount));
        }
      }
      return list;
    };
    return _this;
  })();
  var qrBitBuffer = function() {
    const _buffer = [];
    let _length = 0;
    const _this = {};
    _this.getBuffer = function() {
      return _buffer;
    };
    _this.getAt = function(index) {
      const bufIndex = Math.floor(index / 8);
      return (_buffer[bufIndex] >>> 7 - index % 8 & 1) == 1;
    };
    _this.put = function(num, length) {
      for (let i = 0; i < length; i += 1) {
        _this.putBit((num >>> length - i - 1 & 1) == 1);
      }
    };
    _this.getLengthInBits = function() {
      return _length;
    };
    _this.putBit = function(bit) {
      const bufIndex = Math.floor(_length / 8);
      if (_buffer.length <= bufIndex) {
        _buffer.push(0);
      }
      if (bit) {
        _buffer[bufIndex] |= 128 >>> _length % 8;
      }
      _length += 1;
    };
    return _this;
  };
  var qrNumber = function(data) {
    const _mode = QRMode.MODE_NUMBER;
    const _data = data;
    const _this = {};
    _this.getMode = function() {
      return _mode;
    };
    _this.getLength = function(buffer) {
      return _data.length;
    };
    _this.write = function(buffer) {
      const data2 = _data;
      let i = 0;
      while (i + 2 < data2.length) {
        buffer.put(strToNum(data2.substring(i, i + 3)), 10);
        i += 3;
      }
      if (i < data2.length) {
        if (data2.length - i == 1) {
          buffer.put(strToNum(data2.substring(i, i + 1)), 4);
        } else if (data2.length - i == 2) {
          buffer.put(strToNum(data2.substring(i, i + 2)), 7);
        }
      }
    };
    const strToNum = function(s) {
      let num = 0;
      for (let i = 0; i < s.length; i += 1) {
        num = num * 10 + chatToNum(s.charAt(i));
      }
      return num;
    };
    const chatToNum = function(c) {
      if ("0" <= c && c <= "9") {
        return c.charCodeAt(0) - "0".charCodeAt(0);
      }
      throw "illegal char :" + c;
    };
    return _this;
  };
  var qrAlphaNum = function(data) {
    const _mode = QRMode.MODE_ALPHA_NUM;
    const _data = data;
    const _this = {};
    _this.getMode = function() {
      return _mode;
    };
    _this.getLength = function(buffer) {
      return _data.length;
    };
    _this.write = function(buffer) {
      const s = _data;
      let i = 0;
      while (i + 1 < s.length) {
        buffer.put(
          getCode(s.charAt(i)) * 45 + getCode(s.charAt(i + 1)),
          11
        );
        i += 2;
      }
      if (i < s.length) {
        buffer.put(getCode(s.charAt(i)), 6);
      }
    };
    const getCode = function(c) {
      if ("0" <= c && c <= "9") {
        return c.charCodeAt(0) - "0".charCodeAt(0);
      } else if ("A" <= c && c <= "Z") {
        return c.charCodeAt(0) - "A".charCodeAt(0) + 10;
      } else {
        switch (c) {
          case " ":
            return 36;
          case "$":
            return 37;
          case "%":
            return 38;
          case "*":
            return 39;
          case "+":
            return 40;
          case "-":
            return 41;
          case ".":
            return 42;
          case "/":
            return 43;
          case ":":
            return 44;
          default:
            throw "illegal char :" + c;
        }
      }
    };
    return _this;
  };
  var qr8BitByte = function(data) {
    const _mode = QRMode.MODE_8BIT_BYTE;
    const _data = data;
    const _bytes = qrcode.stringToBytes(data);
    const _this = {};
    _this.getMode = function() {
      return _mode;
    };
    _this.getLength = function(buffer) {
      return _bytes.length;
    };
    _this.write = function(buffer) {
      for (let i = 0; i < _bytes.length; i += 1) {
        buffer.put(_bytes[i], 8);
      }
    };
    return _this;
  };
  var qrKanji = function(data) {
    const _mode = QRMode.MODE_KANJI;
    const _data = data;
    const stringToBytes2 = qrcode.stringToBytes;
    !(function(c, code) {
      const test = stringToBytes2(c);
      if (test.length != 2 || (test[0] << 8 | test[1]) != code) {
        throw "sjis not supported.";
      }
    })("\u53CB", 38726);
    const _bytes = stringToBytes2(data);
    const _this = {};
    _this.getMode = function() {
      return _mode;
    };
    _this.getLength = function(buffer) {
      return ~~(_bytes.length / 2);
    };
    _this.write = function(buffer) {
      const data2 = _bytes;
      let i = 0;
      while (i + 1 < data2.length) {
        let c = (255 & data2[i]) << 8 | 255 & data2[i + 1];
        if (33088 <= c && c <= 40956) {
          c -= 33088;
        } else if (57408 <= c && c <= 60351) {
          c -= 49472;
        } else {
          throw "illegal char at " + (i + 1) + "/" + c;
        }
        c = (c >>> 8 & 255) * 192 + (c & 255);
        buffer.put(c, 13);
        i += 2;
      }
      if (i < data2.length) {
        throw "illegal char at " + (i + 1);
      }
    };
    return _this;
  };
  var byteArrayOutputStream = function() {
    const _bytes = [];
    const _this = {};
    _this.writeByte = function(b) {
      _bytes.push(b & 255);
    };
    _this.writeShort = function(i) {
      _this.writeByte(i);
      _this.writeByte(i >>> 8);
    };
    _this.writeBytes = function(b, off, len) {
      off = off || 0;
      len = len || b.length;
      for (let i = 0; i < len; i += 1) {
        _this.writeByte(b[i + off]);
      }
    };
    _this.writeString = function(s) {
      for (let i = 0; i < s.length; i += 1) {
        _this.writeByte(s.charCodeAt(i));
      }
    };
    _this.toByteArray = function() {
      return _bytes;
    };
    _this.toString = function() {
      let s = "";
      s += "[";
      for (let i = 0; i < _bytes.length; i += 1) {
        if (i > 0) {
          s += ",";
        }
        s += _bytes[i];
      }
      s += "]";
      return s;
    };
    return _this;
  };
  var base64EncodeOutputStream = function() {
    let _buffer = 0;
    let _buflen = 0;
    let _length = 0;
    let _base64 = "";
    const _this = {};
    const writeEncoded = function(b) {
      _base64 += String.fromCharCode(encode(b & 63));
    };
    const encode = function(n) {
      if (n < 0) {
        throw "n:" + n;
      } else if (n < 26) {
        return 65 + n;
      } else if (n < 52) {
        return 97 + (n - 26);
      } else if (n < 62) {
        return 48 + (n - 52);
      } else if (n == 62) {
        return 43;
      } else if (n == 63) {
        return 47;
      } else {
        throw "n:" + n;
      }
    };
    _this.writeByte = function(n) {
      _buffer = _buffer << 8 | n & 255;
      _buflen += 8;
      _length += 1;
      while (_buflen >= 6) {
        writeEncoded(_buffer >>> _buflen - 6);
        _buflen -= 6;
      }
    };
    _this.flush = function() {
      if (_buflen > 0) {
        writeEncoded(_buffer << 6 - _buflen);
        _buffer = 0;
        _buflen = 0;
      }
      if (_length % 3 != 0) {
        const padlen = 3 - _length % 3;
        for (let i = 0; i < padlen; i += 1) {
          _base64 += "=";
        }
      }
    };
    _this.toString = function() {
      return _base64;
    };
    return _this;
  };
  var base64DecodeInputStream = function(str) {
    const _str = str;
    let _pos = 0;
    let _buffer = 0;
    let _buflen = 0;
    const _this = {};
    _this.read = function() {
      while (_buflen < 8) {
        if (_pos >= _str.length) {
          if (_buflen == 0) {
            return -1;
          }
          throw "unexpected end of file./" + _buflen;
        }
        const c = _str.charAt(_pos);
        _pos += 1;
        if (c == "=") {
          _buflen = 0;
          return -1;
        } else if (c.match(/^\s$/)) {
          continue;
        }
        _buffer = _buffer << 6 | decode(c.charCodeAt(0));
        _buflen += 6;
      }
      const n = _buffer >>> _buflen - 8 & 255;
      _buflen -= 8;
      return n;
    };
    const decode = function(c) {
      if (65 <= c && c <= 90) {
        return c - 65;
      } else if (97 <= c && c <= 122) {
        return c - 97 + 26;
      } else if (48 <= c && c <= 57) {
        return c - 48 + 52;
      } else if (c == 43) {
        return 62;
      } else if (c == 47) {
        return 63;
      } else {
        throw "c:" + c;
      }
    };
    return _this;
  };
  var gifImage = function(width, height) {
    const _width = width;
    const _height = height;
    const _data = new Array(width * height);
    const _this = {};
    _this.setPixel = function(x, y, pixel) {
      _data[y * _width + x] = pixel;
    };
    _this.write = function(out) {
      out.writeString("GIF87a");
      out.writeShort(_width);
      out.writeShort(_height);
      out.writeByte(128);
      out.writeByte(0);
      out.writeByte(0);
      out.writeByte(0);
      out.writeByte(0);
      out.writeByte(0);
      out.writeByte(255);
      out.writeByte(255);
      out.writeByte(255);
      out.writeString(",");
      out.writeShort(0);
      out.writeShort(0);
      out.writeShort(_width);
      out.writeShort(_height);
      out.writeByte(0);
      const lzwMinCodeSize = 2;
      const raster = getLZWRaster(lzwMinCodeSize);
      out.writeByte(lzwMinCodeSize);
      let offset = 0;
      while (raster.length - offset > 255) {
        out.writeByte(255);
        out.writeBytes(raster, offset, 255);
        offset += 255;
      }
      out.writeByte(raster.length - offset);
      out.writeBytes(raster, offset, raster.length - offset);
      out.writeByte(0);
      out.writeString(";");
    };
    const bitOutputStream = function(out) {
      const _out = out;
      let _bitLength = 0;
      let _bitBuffer = 0;
      const _this2 = {};
      _this2.write = function(data, length) {
        if (data >>> length != 0) {
          throw "length over";
        }
        while (_bitLength + length >= 8) {
          _out.writeByte(255 & (data << _bitLength | _bitBuffer));
          length -= 8 - _bitLength;
          data >>>= 8 - _bitLength;
          _bitBuffer = 0;
          _bitLength = 0;
        }
        _bitBuffer = data << _bitLength | _bitBuffer;
        _bitLength = _bitLength + length;
      };
      _this2.flush = function() {
        if (_bitLength > 0) {
          _out.writeByte(_bitBuffer);
        }
      };
      return _this2;
    };
    const getLZWRaster = function(lzwMinCodeSize) {
      const clearCode = 1 << lzwMinCodeSize;
      const endCode = (1 << lzwMinCodeSize) + 1;
      let bitLength = lzwMinCodeSize + 1;
      const table = lzwTable();
      for (let i = 0; i < clearCode; i += 1) {
        table.add(String.fromCharCode(i));
      }
      table.add(String.fromCharCode(clearCode));
      table.add(String.fromCharCode(endCode));
      const byteOut = byteArrayOutputStream();
      const bitOut = bitOutputStream(byteOut);
      bitOut.write(clearCode, bitLength);
      let dataIndex = 0;
      let s = String.fromCharCode(_data[dataIndex]);
      dataIndex += 1;
      while (dataIndex < _data.length) {
        const c = String.fromCharCode(_data[dataIndex]);
        dataIndex += 1;
        if (table.contains(s + c)) {
          s = s + c;
        } else {
          bitOut.write(table.indexOf(s), bitLength);
          if (table.size() < 4095) {
            if (table.size() == 1 << bitLength) {
              bitLength += 1;
            }
            table.add(s + c);
          }
          s = c;
        }
      }
      bitOut.write(table.indexOf(s), bitLength);
      bitOut.write(endCode, bitLength);
      bitOut.flush();
      return byteOut.toByteArray();
    };
    const lzwTable = function() {
      const _map = {};
      let _size = 0;
      const _this2 = {};
      _this2.add = function(key) {
        if (_this2.contains(key)) {
          throw "dup key:" + key;
        }
        _map[key] = _size;
        _size += 1;
      };
      _this2.size = function() {
        return _size;
      };
      _this2.indexOf = function(key) {
        return _map[key];
      };
      _this2.contains = function(key) {
        return typeof _map[key] != "undefined";
      };
      return _this2;
    };
    return _this;
  };
  var createDataURL = function(width, height, getPixel) {
    const gif = gifImage(width, height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        gif.setPixel(x, y, getPixel(x, y));
      }
    }
    const b = byteArrayOutputStream();
    gif.write(b);
    const base64 = base64EncodeOutputStream();
    const bytes = b.toByteArray();
    for (let i = 0; i < bytes.length; i += 1) {
      base64.writeByte(bytes[i]);
    }
    base64.flush();
    return "data:image/gif;base64," + base64;
  };
  var qrcode_default = qrcode;
  var stringToBytes = qrcode.stringToBytes;

  // dashboard/src/index.ts
  (function() {
    var _a, _b;
    const SDK = window.__HERMES_PLUGIN_SDK__;
    if (!SDK) return;
    const React = SDK.React;
    const h = React.createElement;
    const { useState, useEffect, useCallback } = SDK.hooks;
    const C = SDK.components || {};
    const Card = C.Card || "div", CardHeader = C.CardHeader || "div", CardTitle = C.CardTitle || "h3", CardContent = C.CardContent || "div";
    const Button = C.Button || "button", Badge = C.Badge || "span";
    const API = "/api/plugins/fieldkit";
    const get = (p) => SDK.fetchJSON(`${API}/${p}`);
    const post = (p, body) => SDK.fetchJSON(`${API}/${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body != null ? body : {})
    });
    const del = (p) => SDK.fetchJSON(`${API}/${p}`, { method: "DELETE" });
    const ts = (v) => v ? new Date(typeof v === "number" ? v * 1e3 : v).toLocaleString() : "\u2014";
    const APP_PATH = "/dashboard-plugins/fieldkit/app_dist/index.html";
    const appUrl = () => `${window.location.origin}${APP_PATH}`;
    const box = { border: "1px solid var(--border, #e5e7eb)", borderRadius: 10, padding: 12, marginBottom: 12 };
    const pre = { whiteSpace: "pre-wrap", fontSize: 12, maxHeight: 360, overflow: "auto", background: "rgba(127,127,127,.08)", padding: 8, borderRadius: 6 };
    const row = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" };
    const sevColor = { critical: "#b91c1c", high: "#dc2626", medium: "#d97706", low: "#15803d", info: "#2563eb" };
    function useLoad(fn, deps = []) {
      const [data, setData] = useState(null);
      const [err, setErr] = useState(null);
      const load = useCallback(() => {
        fn().then((d) => {
          setData(d);
          setErr(null);
        }, (e) => {
          var _a2;
          return setErr(String((_a2 = e == null ? void 0 : e.message) != null ? _a2 : e));
        });
      }, deps);
      useEffect(() => {
        load();
      }, [load]);
      return [data, err, load];
    }
    function Section(props) {
      return h(
        Card,
        { style: { marginBottom: 16 } },
        h(CardHeader, null, h("div", { style: { ...row, justifyContent: "space-between" } }, h(CardTitle, null, props.title), props.actions)),
        h(CardContent, null, props.children)
      );
    }
    function Err({ msg }) {
      return msg ? h("div", { style: { color: "#b91c1c", margin: "8px 0" } }, msg) : null;
    }
    function Sev({ s }) {
      var _a2;
      return h(Badge, { style: { color: (_a2 = sevColor[s]) != null ? _a2 : void 0 } }, s);
    }
    function Overview() {
      const [st, err, reload] = useLoad(() => Promise.all([get("status"), get("sync/status"), get("records?limit=5"), get("reports?limit=5")]));
      const [msg, setMsg] = useState("");
      if (!st) return h(Err, { msg: err }) || h("div", null, "Loading\u2026");
      const [status, sync, recs, reps] = st;
      return h(
        "div",
        null,
        h(
          Section,
          { title: "FieldKit status", actions: h(Button, { onClick: () => post("examples/install").then((r) => {
            setMsg(`Installed ${r.workflows.length} workflows, ${r.packs.length} packs`);
            reload();
          }) }, "Install example workflows") },
          msg && h("div", { style: { marginBottom: 8 } }, msg),
          h(
            "div",
            { style: row },
            h(Badge, null, `analysis: ${status.analysis_mode}`),
            h(Badge, null, `LLM ${status.llm_available ? "available" : "not in this process"}`),
            h(Badge, null, `auto-analyze ${status.auto_analyze ? "on" : "off"}`),
            h(Badge, null, `app ${status.app_built ? "built" : "NOT built"}`)
          ),
          status.analysis_mode === "deferred" && h(
            "p",
            { style: { fontSize: 13, opacity: 0.8 } },
            "Automatic analysis jobs are queued durably. Ask Hermes to run \u201Cfieldkit_process_pending_jobs\u201D, or schedule it with a Hermes cron job."
          ),
          h("p", null, `Records: ${counts(sync.records_by_sync_status)} \xB7 Analysis: ${counts(sync.records_by_analysis_status)} \xB7 Jobs: ${counts(sync.jobs)} \xB7 Open conflicts: ${sync.open_conflicts}`)
        ),
        h(Section, { title: "Recent records" }, h(RecordList, { records: recs.records })),
        h(Section, { title: "Recent reports" }, reps.reports.length ? reps.reports.map((r) => h(
          "div",
          { key: r.id, style: box },
          h("b", null, title(r)),
          ` \xB7 report v${r.version} \xB7 ${ts(r.created_at)}`,
          r.requires_review && h(Badge, { style: { marginLeft: 8, color: "#d97706" } }, "needs review"),
          h("div", null, r.summary)
        )) : "No reports yet.")
      );
    }
    function Workflows() {
      var _a2;
      const [data, err, reload] = useLoad(() => get("workflows?include_drafts=true"));
      const [sel, setSel] = useState(null);
      const [json, setJson] = useState("");
      const [problems, setProblems] = useState(null);
      const [msg, setMsg] = useState("");
      const open = (id) => get(`workflows/${encodeURIComponent(id)}?draft=true`).then(setSel, (e) => setMsg(String(e)));
      const save = (publish) => {
        let def;
        try {
          def = JSON.parse(json);
        } catch (e) {
          setProblems([{ path: "", message: `Invalid JSON: ${e}` }]);
          return;
        }
        post("workflows", { definition: def, publish }).then(
          (r) => {
            setProblems(null);
            setMsg(`Saved ${r.workflow.id} v${r.workflow.version}`);
            reload();
          },
          (e) => {
            var _a3;
            return setProblems([{ path: "", message: String((_a3 = e == null ? void 0 : e.message) != null ? _a3 : e) }]);
          }
        );
      };
      return h(
        "div",
        null,
        h(
          Section,
          { title: "Workflows" },
          h(Err, { msg: err }),
          msg && h("div", null, msg),
          ((_a2 = data == null ? void 0 : data.workflows) != null ? _a2 : []).map((w) => h(
            "div",
            { key: w.id, style: { ...box, ...row } },
            h("div", { style: { flex: 1 } }, h("b", null, w.title), ` \xB7 ${w.domain || "general"} \xB7 latest v${w.latest_version} \xB7 published ${w.published_version ? `v${w.published_version}` : "no"}`),
            h(Button, { onClick: () => open(w.id) }, "View"),
            w.published_version !== w.latest_version && h(Button, { onClick: () => post(`workflows/${w.id}/publish`, {}).then(reload) }, "Publish latest"),
            h("a", { href: `${APP_PATH}#/workflow/${encodeURIComponent(w.id)}`, target: "_blank", rel: "noopener" }, "Open in app")
          ))
        ),
        sel && h(
          Section,
          { title: `Definition: ${sel.id} v${sel.version} (${sel.status})`, actions: h(Button, { onClick: () => setSel(null) }, "Close") },
          h("pre", { style: pre }, JSON.stringify(sel, null, 2))
        ),
        h(
          Section,
          { title: "Import / edit workflow JSON" },
          h("p", { style: { fontSize: 13, opacity: 0.8 } }, "Usually you create workflows by asking Hermes. Paste a FieldKit workflow definition to validate and save it here."),
          h("textarea", { value: json, onChange: (e) => setJson(e.target.value), rows: 10, style: { width: "100%", fontFamily: "monospace" } }),
          h("div", { style: row }, h(Button, { onClick: () => save(false) }, "Validate & save draft"), h(Button, { onClick: () => save(true) }, "Save & publish")),
          problems && h("ul", { style: { color: "#b91c1c" } }, problems.map((p, i) => h("li", { key: i }, `${p.path || "/"}: ${p.message}`)))
        )
      );
    }
    function Knowledge() {
      var _a2;
      const [data, err, reload] = useLoad(() => get("packs"));
      const [form, setForm] = useState({ pack_id: "", title: "", domain: "", language: "en", document: "" });
      const [msg, setMsg] = useState("");
      const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
      const input = (k, ph) => h("input", { value: form[k], onChange: set(k), placeholder: ph, style: { flex: 1, minWidth: 140 } });
      return h(
        "div",
        null,
        h(
          Section,
          { title: "Knowledge & dictionary packs" },
          h(Err, { msg: err }),
          ((_a2 = data == null ? void 0 : data.packs) != null ? _a2 : []).filter((p) => p.kind !== "model").map((p) => h(
            "div",
            { key: p.id, style: { ...box, ...row } },
            h("div", { style: { flex: 1 } }, h("b", null, p.title), ` \xB7 ${p.kind} v${p.version} \xB7 ${p.domain || "general"} \xB7 ${(p.size / 1024).toFixed(1)} KiB \xB7 sha256 ${p.sha256.slice(0, 10)}\u2026`),
            h(Button, { onClick: () => del(`packs/${p.id}`).then(reload, (e) => setMsg(String(e))) }, "Delete")
          ))
        ),
        h(
          Section,
          { title: "Import a document as a knowledge pack" },
          h("p", { style: { fontSize: 13, opacity: 0.8 } }, "Deterministic import: headings become topics. For richer packs (FAQs, troubleshooting), ask Hermes to run fieldkit_create_knowledge_pack on the document."),
          h("div", { style: row }, input("pack_id", "pack-id (slug)"), input("title", "Title"), input("domain", "Domain (any)"), input("language", "Language code")),
          h("textarea", { value: form.document, onChange: set("document"), rows: 10, placeholder: "Paste text or markdown\u2026", style: { width: "100%", marginTop: 8 } }),
          h(Button, { onClick: () => post("packs/from-document", form).then((r) => {
            setMsg(`Created ${r.pack.id} with ${r.entries} entries`);
            reload();
          }, (e) => {
            var _a3;
            return setMsg(String((_a3 = e == null ? void 0 : e.message) != null ? _a3 : e));
          }) }, "Create pack"),
          msg && h("div", { style: { marginTop: 8 } }, msg)
        )
      );
    }
    const STATE_WORDS = {
      complete: "complete",
      received: "files still uploading",
      not_requested: "not analysed",
      pending: "waiting for analysis",
      processing: "being analysed",
      completed: "analysed",
      failed: "failed",
      requires_review: "need human review",
      done: "done",
      queued: "queued"
    };
    function counts(o) {
      const parts = Object.entries(o != null ? o : {}).filter(([, n]) => Number(n) > 0).map(([k, n]) => {
        var _a2;
        return `${n} ${(_a2 = STATE_WORDS[k]) != null ? _a2 : k.replace(/_/g, " ")}`;
      });
      return parts.length ? parts.join(", ") : "none";
    }
    function title(r) {
      return `${r.workflow_title || r.workflow_id}${r.subject ? ` \xB7 ${r.subject}` : ""}`;
    }
    const small = { fontSize: 11, opacity: 0.55, fontFamily: "monospace" };
    const ANALYSIS_LABEL = {
      requires_review: "needs review",
      completed: "analysed",
      pending: "waiting",
      processing: "analysing",
      failed: "failed",
      not_requested: "not analysed"
    };
    function RecordList({ records }) {
      const [open, setOpen] = useState(null);
      if (!(records == null ? void 0 : records.length)) return h("div", null, "No synchronised records yet.");
      return h("div", null, records.map((r) => {
        var _a2, _b2;
        return h(
          "div",
          { key: r.id, style: box },
          h(
            "div",
            { style: row },
            h("div", { style: { flex: 1 } }, h("b", null, title(r)), h("div", { style: small }, r.id)),
            h(Badge, null, r.sync_status === "complete" ? "synced" : (_a2 = STATE_WORDS[r.sync_status]) != null ? _a2 : r.sync_status),
            h(Badge, null, (_b2 = ANALYSIS_LABEL[r.analysis_status]) != null ? _b2 : r.analysis_status),
            h("span", null, ts(r.received_at)),
            h(Button, { onClick: () => setOpen(open === r.id ? null : r.id) }, open === r.id ? "Hide" : "Details")
          ),
          open === r.id && h(RecordDetail, { id: r.id })
        );
      }));
    }
    function Attachment({ a }) {
      const [url, setUrl] = useState(null);
      useEffect(() => {
        if (a.status !== "stored") return;
        let u = null;
        const fetcher = SDK.authedFetch || fetch;
        fetcher(`${API}/attachments/${a.id}`).then((r) => r.blob()).then((b) => {
          u = URL.createObjectURL(b);
          setUrl(u);
        }).catch(() => void 0);
        return () => {
          if (u) URL.revokeObjectURL(u);
        };
      }, [a.id]);
      const noun = a.kind === "signature" ? "Signature" : a.kind === "audio" ? "Voice note" : a.kind === "photo" ? "Photo" : "File";
      if (a.status !== "stored") return h("div", null, `${noun} (${a.mime}) \u2014 still uploading`);
      if (!url) return h("div", null, `Loading ${noun.toLowerCase()}\u2026`);
      return h(
        "figure",
        { style: { margin: "0 8px 8px 0" } },
        String(a.mime).startsWith("audio/") ? h("audio", { controls: true, src: url }) : h("img", { src: url, style: { maxWidth: 220, borderRadius: 8, background: a.kind === "signature" ? "#fff" : void 0 } }),
        h("figcaption", { style: { fontSize: 12, opacity: 0.75 } }, `${noun}${a.field_label ? ` \xB7 ${a.field_label}` : ""}${a.signed_at ? ` \xB7 signed ${String(a.signed_at).replace("T", " ").slice(0, 16)}` : ""}${a.transcript ? ` \xB7 \u201C${a.transcript}\u201D` : ""}`)
      );
    }
    function RecordDetail({ id }) {
      var _a2, _b2, _c;
      const [data, err, reload] = useLoad(() => Promise.all([get(`records/${id}`), get(`records/${id}/report`).catch(() => null)]), [id]);
      const [msg, setMsg] = useState("");
      if (!data) return h(Err, { msg: err }) || h("div", null, "Loading\u2026");
      const [rec, rep] = data;
      return h(
        "div",
        { style: { marginTop: 8 } },
        h(
          "div",
          { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } },
          h("div", null, h("b", null, "Answers"), h("pre", { style: pre }, JSON.stringify(rec.answers, null, 2))),
          h(
            "div",
            null,
            h("b", { style: { color: "#7c3aed" } }, "Local findings (computed on the phone)"),
            ((_b2 = (_a2 = rec.local_results) == null ? void 0 : _a2.findings) != null ? _b2 : []).map((f, i) => h("div", { key: i }, h(Sev, { s: f.severity }), " ", f.label, f.detail ? ` \u2014 ${f.detail}` : ""))
          )
        ),
        ((_c = rec.attachments) == null ? void 0 : _c.length) > 0 && h(
          "div",
          { style: { marginTop: 8 } },
          h("b", null, rec.attachment_summary || `${rec.attachments.length} file(s)`),
          h("div", { style: { ...row, flexWrap: "wrap" } }, rec.attachments.map((a) => h(Attachment, { key: a.id, a })))
        ),
        h(
          "div",
          { style: { marginTop: 8 } },
          h("b", { style: { color: "#0f766e" } }, "Hermes report"),
          rep ? h(ReportView, { r: rep }) : h("div", null, `No report yet (analysis: ${rec.analysis_status}).`),
          h("div", { style: row }, h(Button, { onClick: () => post(`records/${id}/analyze`).then((r) => {
            setMsg(`Analysis ${r.analysis_status} (${r.analysis_mode})`);
            reload();
          }, (e) => setMsg(String(e))) }, rep ? "Re-analyse" : "Request analysis"), msg)
        )
      );
    }
    const INTEGRITY = {
      intact: "intact (SHA-256 verified)",
      mismatch: "DOES NOT MATCH the captured file",
      missing: "missing",
      not_uploaded: "not uploaded yet"
    };
    function Evidence({ att }) {
      var _a2;
      const vn = (_a2 = att.voice_notes) != null ? _a2 : {};
      return h(
        "div",
        { style: { margin: "6px 0" } },
        h("b", null, "Evidence: "),
        att.summary,
        vn.attached > 0 && h(
          "div",
          null,
          `Voice notes: ${vn.transcribed} of ${vn.attached} transcribed`,
          att.evidence.filter((e) => e.kind === "audio").map((e) => {
            var _a3;
            return h(
              "div",
              { key: e.attachment_id, style: { fontSize: 13 } },
              e.transcript ? `\u201C${e.transcript}\u201D (${e.transcript_source === "device" ? "transcribed on the phone" : "transcribed by Hermes"})` : `Not transcribed: ${(_a3 = e.transcript_error) != null ? _a3 : "unknown reason"}`
            );
          })
        ),
        att.evidence.filter((e) => e.kind === "signature").map((e) => {
          var _a3;
          return h(
            "div",
            { key: e.attachment_id, style: { marginTop: 4 } },
            `${e.field_label || "Signature"}${e.signed_at ? ` \u2014 signed ${String(e.signed_at).replace("T", " ").slice(0, 16)}` : ""} \xB7 file ${(_a3 = INTEGRITY[e.integrity]) != null ? _a3 : e.integrity}`,
            e.stored && h(Attachment, { a: { id: e.attachment_id, mime: e.mime, status: "stored", kind: "signature" } })
          );
        })
      );
    }
    function ReportView({ r }) {
      var _a2, _b2, _c, _d, _e, _f, _g;
      return h(
        "div",
        { style: box },
        h("div", { style: { fontSize: 12, opacity: 0.7 } }, `v${r.version} \xB7 ${ts(r.generated_at)} \xB7 ${r.generated_by} \xB7 ${r.provider || ""} ${r.model || ""}`),
        r.requires_review && h("div", { style: { color: "#d97706", fontWeight: 600 } }, `Requires human review${r.review_reason ? `: ${r.review_reason}` : ""}`),
        h("p", null, r.summary),
        ((_a2 = r.images) == null ? void 0 : _a2.note) && h(
          "div",
          { style: { margin: "6px 0", padding: 8, borderRadius: 6, border: `1px solid ${r.images.analyzed === false ? "#d97706" : "#0f766e"}` } },
          h("b", null, r.images.analyzed === false ? "Photos not analysed: " : "Photos: "),
          r.images.note
        ),
        ((_c = (_b2 = r.attachments) == null ? void 0 : _b2.evidence) == null ? void 0 : _c.length) > 0 && h(Evidence, { att: r.attachments }),
        ((_d = r.issues) == null ? void 0 : _d.length) > 0 && h("div", null, h("b", null, "Issues"), r.issues.map((i, k) => h("div", { key: k }, h(Sev, { s: i.severity }), ` ${i.title} \u2014 ${i.evidence}`))),
        ((_e = r.missing_information) == null ? void 0 : _e.length) > 0 && h("div", null, h("b", null, "Missing information"), h("ul", null, r.missing_information.map((m, k) => h("li", { key: k }, m)))),
        ((_f = r.suggested_actions) == null ? void 0 : _f.length) > 0 && h("div", null, h("b", null, "Suggested actions"), h("ul", null, r.suggested_actions.map((a, k) => h("li", { key: k }, `[${a.priority}] ${a.action}`)))),
        ((_g = r.references) == null ? void 0 : _g.length) > 0 && h("div", null, h("b", null, "References"), h("ul", null, r.references.map((x, k) => h("li", { key: k }, `${x.title}${x.source ? ` \u2014 ${x.source}` : ""}`))))
      );
    }
    function Records() {
      var _a2;
      const [wf, setWf] = useState("");
      const [data, err] = useLoad(() => get(`records?limit=100${wf ? `&workflow_id=${encodeURIComponent(wf)}` : ""}`), [wf]);
      return h(
        Section,
        { title: "Synchronised records" },
        h(Err, { msg: err }),
        h("input", { placeholder: "Filter by workflow id (e.g. equipment-inspection)", value: wf, onChange: (e) => setWf(e.target.value), style: { marginBottom: 8 } }),
        h(RecordList, { records: (_a2 = data == null ? void 0 : data.records) != null ? _a2 : [] })
      );
    }
    function Reports() {
      const [data, err, reload] = useLoad(() => Promise.all([get("reports?limit=100"), get("followups")]));
      const [open, setOpen] = useState(null);
      const [full, setFull] = useState(null);
      useEffect(() => {
        if (open) get(`reports/${open}`).then(setFull);
      }, [open]);
      if (!data) return h(Err, { msg: err }) || h("div", null, "Loading\u2026");
      const [reps, fus] = data;
      return h(
        "div",
        null,
        h(Section, { title: "Reports" }, reps.reports.length ? reps.reports.map((r) => h(
          "div",
          { key: r.id, style: box },
          h(
            "div",
            { style: row },
            h("div", { style: { flex: 1 } }, h("b", null, `${title(r)} \xB7 report v${r.version}`), h("div", { style: small }, r.record_id)),
            r.requires_review && h(Badge, { style: { color: "#d97706" } }, "needs review"),
            h("span", null, ts(r.created_at)),
            h(Button, { onClick: () => setOpen(open === r.id ? null : r.id) }, open === r.id ? "Hide" : "Open")
          ),
          open === r.id && full ? h(ReportView, { r: full }) : h("div", null, r.summary)
        )) : "No reports yet."),
        h(Section, { title: "Follow-up actions" }, fus.followups.length ? fus.followups.map((f) => h(
          "div",
          { key: f.id, style: { ...box, ...row } },
          h("div", { style: { flex: 1, textDecoration: f.status === "done" ? "line-through" : "none" } }, h("b", null, f.title), f.due_date ? ` \xB7 due ${f.due_date}` : "", f.detail ? h("div", null, f.detail) : null),
          h(Badge, null, f.source),
          h(Button, { onClick: () => post(`followups/${f.id}`, { status: f.status === "done" ? "open" : "done" }).then(reload) }, f.status === "done" ? "Reopen" : "Mark done")
        )) : "No follow-ups.")
      );
    }
    function Sync() {
      const [data, err, reload] = useLoad(() => Promise.all([get("sync/status"), get("sync/conflicts"), get("jobs")]));
      if (!data) return h(Err, { msg: err }) || h("div", null, "Loading\u2026");
      const [st, cf, jobs] = data;
      return h(
        "div",
        null,
        h(
          Section,
          { title: "Synchronisation", actions: h(Button, { onClick: reload }, "Refresh") },
          h("div", null, `Last record received: ${ts(st.last_received_at)} \xB7 Attachments outstanding: ${st.attachments_outstanding} \xB7 Open conflicts: ${st.open_conflicts}`),
          h("div", null, `Records: ${counts(st.records_by_sync_status)} \xB7 Analysis: ${counts(st.records_by_analysis_status)}`),
          h("div", { style: { marginTop: 8 } }, h("b", null, "Devices"), st.devices.map((d) => h("div", { key: d.id }, `${d.label || "Unnamed device"} \xB7 last seen ${ts(d.last_seen)} `, h("span", { style: small }, d.id))))
        ),
        h(Section, { title: "Conflicts" }, cf.conflicts.length ? cf.conflicts.map((c) => {
          var _a2, _b2;
          return h(
            "div",
            { key: c.id, style: box },
            h("div", null, `Record ${c.record_id}: phone edited revision ${c.base_revision}, server is at ${c.server_revision}`),
            h("pre", { style: pre }, JSON.stringify((_b2 = (_a2 = c.client_payload) == null ? void 0 : _a2.record) == null ? void 0 : _b2.answers, null, 2)),
            h(
              "div",
              { style: row },
              h(Button, { onClick: () => post(`sync/conflicts/${c.id}/resolve`, { resolution: "keep_server" }).then(reload) }, "Keep server version"),
              h(Button, { onClick: () => post(`sync/conflicts/${c.id}/resolve`, { resolution: "use_client" }).then(reload) }, "Use phone version")
            )
          );
        }) : "No open conflicts."),
        h(Section, { title: `Analysis jobs (mode: ${jobs.mode})` }, jobs.jobs.length ? h(
          "table",
          { style: { width: "100%", fontSize: 13 } },
          h("thead", null, h("tr", null, ["job", "record", "rev", "status", "attempts", "updated", "error"].map((x) => h("th", { key: x, style: { textAlign: "left" } }, x)))),
          h("tbody", null, jobs.jobs.map((j) => h(
            "tr",
            { key: j.id },
            h("td", null, j.id),
            h("td", null, j.record_id),
            h("td", null, j.revision),
            h("td", null, j.status),
            h("td", null, j.attempts),
            h("td", null, ts(j.updated_at)),
            h("td", { style: { color: "#b91c1c" } }, j.last_error || "")
          )))
        ) : "No jobs yet.")
      );
    }
    function OfflinePacks() {
      const [data, err] = useLoad(() => get("models"));
      if (!data) return h(Err, { msg: err }) || h("div", null, "Loading\u2026");
      return h(
        "div",
        null,
        h(
          Section,
          { title: "On-device model packs" },
          h("p", { style: { fontSize: 13, opacity: 0.8 } }, data.description),
          data.packs.map((m) => {
            var _a2;
            return h(
              "div",
              { key: m.id, style: box },
              h("b", null, m.title),
              ` \xB7 ${m.capability} \xB7 ${(m.download_size / 1e6).toFixed(1)} MB \xB7 ${m.license}`,
              h("div", { style: { fontSize: 12, opacity: 0.75 } }, m.model ? `${m.model}@${(_a2 = m.revision) == null ? void 0 : _a2.slice(0, 10)}` : m.engine, " \xB7 ", m.files.map((f) => f.url.split("/").pop()).join(", "))
            );
          })
        ),
        h(Section, { title: "Pinned runtimes" }, data.runtimes.map((r) => h("div", { key: r.id }, `${r.id}@${r.version} \xB7 ${r.license} \xB7 ${r.fetched_from}`)))
      );
    }
    function Mobile() {
      const url = appUrl();
      const qr = qrcode_default(0, "M");
      qr.addData(url);
      qr.make();
      return h(
        Section,
        { title: "Open FieldKit on a phone" },
        h(
          "div",
          { style: { ...row, alignItems: "flex-start" } },
          h("img", { src: qr.createDataURL(6, 8), alt: "QR code for the FieldKit app", style: { background: "#fff", borderRadius: 8 } }),
          h(
            "div",
            { style: { flex: 1, minWidth: 240 } },
            h("p", null, h("a", { href: url, target: "_blank", rel: "noopener" }, url)),
            h(
              "ol",
              null,
              h("li", null, "Scan the code (or open the link) on the phone while online and sign in to Hermes."),
              h("li", null, "Open Offline Packs and download workflows, knowledge, dictionaries and any translation / OCR / speech models."),
              h("li", null, "Add to Home Screen (Android: menu \u2192 Install app; iPhone: Share \u2192 Add to Home Screen)."),
              h("li", null, "Check the Offline readiness card on Home, then it works with no connection.")
            ),
            h("p", { style: { fontSize: 13, opacity: 0.8 } }, "Service workers need HTTPS. The phone must reach this dashboard over https:// (or localhost).")
          )
        )
      );
    }
    const TABS = [
      ["Overview", Overview],
      ["Workflows", Workflows],
      ["Knowledge", Knowledge],
      ["Records", Records],
      ["Reports", Reports],
      ["Synchronization", Sync],
      ["Offline Packs", OfflinePacks],
      ["Mobile Access", Mobile]
    ];
    function FieldKitPage() {
      var _a2;
      const [tab, setTab] = useState("Overview");
      const View = ((_a2 = TABS.find(([n]) => n === tab)) != null ? _a2 : TABS[0])[1];
      return h(
        "div",
        { style: { padding: 16, maxWidth: 1200 } },
        h("div", { style: { ...row, marginBottom: 16 } }, TABS.map(([n]) => h(Button, { key: n, variant: n === tab ? "default" : "outline", onClick: () => setTab(n) }, n))),
        h(View, null)
      );
    }
    (_b = (_a = window.__HERMES_PLUGINS__) == null ? void 0 : _a.register) == null ? void 0 : _b.call(_a, "fieldkit", FieldKitPage);
  })();
})();
