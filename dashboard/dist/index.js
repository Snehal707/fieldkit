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
    const API = "/api/plugins/fieldkit";
    const get = (p) => SDK.fetchJSON(`${API}/${p}`);
    const post = (p, body) => SDK.fetchJSON(`${API}/${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body != null ? body : {})
    });
    const APP_PATH = "/dashboard-plugins/fieldkit/app_dist/index.html";
    const appUrl = () => `${window.location.origin}${APP_PATH}`;
    const CSS = `
.fk{--ink:var(--midground-base,#1d2a2a);--paper:var(--background-base,#fbfaf7);
  --rule:color-mix(in srgb,var(--ink) 14%,transparent);--rule-soft:color-mix(in srgb,var(--ink) 7%,transparent);
  --mute:color-mix(in srgb,var(--ink) 62%,transparent);--wash:color-mix(in srgb,var(--ink) 4%,transparent);
  --ok:color-mix(in srgb,#3fae80 72%,var(--ink));--wait:color-mix(in srgb,#d39a2c 72%,var(--ink));
  --bad:color-mix(in srgb,#e0533b 78%,var(--ink));--old:color-mix(in srgb,#8f80d6 72%,var(--ink));
  color:var(--ink);font-family:var(--theme-font-sans,inherit);font-size:13px;line-height:1.45;
  padding:16px;max-width:1240px;font-variant-numeric:tabular-nums}
.fk *{box-sizing:border-box}
.fk ::selection{background:color-mix(in srgb,var(--ink) 25%,transparent)}
.fk input{caret-color:var(--ink)}
.fk h2{font-size:15px;font-weight:600;margin:0}
.fk h3{font-size:13px;font-weight:600;margin:0 0 6px}
.fk p{margin:0}
.fk .mute{color:var(--mute)}
.fk .id{font-family:var(--theme-font-mono,ui-monospace,monospace);font-size:11px;color:var(--mute);word-break:break-all}
.fk-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-bottom:12px;border-bottom:1px solid var(--rule);margin-bottom:16px}
.fk-chip{font-size:12px;padding:1px 8px;border:1px solid var(--rule);border-radius:999px;color:var(--mute);white-space:nowrap}
.fk-chip.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 50%,transparent)}
.fk-tabs{margin-left:auto;display:flex;border:1px solid var(--rule);border-radius:7px;overflow:hidden}
.fk-tabs button{all:unset;cursor:pointer;padding:6px 14px;font-size:13px;color:var(--mute);border-left:1px solid var(--rule)}
.fk-tabs button:first-child{border-left:0}
.fk-tabs button:hover{color:var(--ink);background:var(--wash)}
.fk-tabs button[aria-pressed=true]{color:var(--paper);background:var(--ink);font-weight:600}
.fk button:focus-visible,.fk input:focus-visible,.fk summary:focus-visible,.fk a:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.fk-btn{all:unset;cursor:pointer;font-size:12px;padding:4px 10px;border:1px solid var(--rule);border-radius:6px;white-space:nowrap}
.fk-btn:hover{background:var(--wash);border-color:color-mix(in srgb,var(--ink) 30%,transparent)}
.fk-btn.solid{background:var(--ink);color:var(--paper);border-color:var(--ink);font-weight:600}
.fk-btn[disabled]{opacity:.5;cursor:default}
.fk-sec{margin-bottom:24px}
.fk-sec>header{display:flex;align-items:baseline;gap:10px;margin-bottom:8px}
.fk-sec>header .act{margin-left:auto;display:flex;gap:8px;align-items:center}
.fk-cols{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,8fr);gap:28px}
.fk-err{color:var(--bad);margin:6px 0}
.fk-empty{padding:14px 0;color:var(--mute);border-top:1px solid var(--rule)}
/* sync track */
.fk-track{display:flex;height:14px;border-radius:3px;overflow:hidden;background:var(--rule-soft);margin:10px 0 8px}
.fk-track>span{height:100%;min-width:3px}
.fk-legend{display:flex;gap:18px;flex-wrap:wrap;font-size:12px}
.fk-legend b{font-size:15px;font-weight:650;margin-right:4px}
.fk-dot{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;vertical-align:1px}
.fk-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid var(--rule);border-bottom:1px solid var(--rule);margin-top:12px}
.fk-stats>div{padding:8px 12px 8px 0}
.fk-stats>div+div{padding-left:12px;border-left:1px solid var(--rule-soft)}
.fk-stats dt{font-size:12px;color:var(--mute)}
.fk-stats dd{margin:0;font-size:20px;font-weight:650}
.fk-stats dd.small{font-size:13px;font-weight:500;padding-top:6px}
.fk-stats .bad{color:var(--bad)}.fk-stats .wait{color:var(--wait)}
/* ledger */
.fk-ledger{border-top:1px solid var(--rule)}
.fk-line{display:grid;grid-template-columns:8px minmax(0,1fr) minmax(0,170px) 120px 64px 58px;gap:12px;align-items:center;
  padding:6px 0;border-bottom:1px solid var(--rule-soft)}
.fk-line.compact{grid-template-columns:8px minmax(0,1fr) 64px 58px}
.fk-line.compact .state{display:none}
.fk-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.fk-more{all:unset;cursor:pointer;font-size:12px;color:var(--mute);padding:8px 0;text-decoration:underline;text-underline-offset:3px}
.fk-more:hover{color:var(--ink)}
.fk-line .rail{width:8px;height:8px;border-radius:2px;align-self:start;margin-top:6px}
.fk-line .t{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fk-line .sub{font-weight:400;color:var(--mute)}
.fk-line .when{font-size:12px;color:var(--mute);text-align:right}
.fk-line .state{font-size:12px}
.fk-line.open{background:var(--wash)}
.fk-detail{border-bottom:1px solid var(--rule);padding:12px 12px 16px 20px;background:var(--wash)}
.fk-detail-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}
.fk-kv{display:grid;grid-template-columns:minmax(110px,38%) 1fr;margin:0;border-top:1px solid var(--rule-soft)}
.fk-kv dt,.fk-kv dd{margin:0;padding:4px 8px 4px 0;border-bottom:1px solid var(--rule-soft)}
.fk-kv dt{color:var(--mute)}
.fk-kv dd{white-space:pre-wrap;word-break:break-word}
.fk-kv .diff{background:color-mix(in srgb,var(--wait) 16%,transparent)}
.fk-files{display:flex;flex-wrap:wrap;gap:10px}
.fk-files figure{margin:0;width:180px}
.fk-files img{display:block;max-width:180px;max-height:180px;border-radius:4px;border:1px solid var(--rule)}
.fk-files img.sig{background:#fff}
.fk-files audio{width:180px}
.fk-files figcaption{font-size:12px;color:var(--mute);margin-top:3px}
.fk-files .pending{width:180px;padding:10px;border:1px dashed var(--rule);border-radius:4px;font-size:12px;color:var(--mute)}
.fk details>summary{cursor:pointer;color:var(--mute);font-size:12px;margin-top:8px}
.fk pre{white-space:pre-wrap;font-size:12px;max-height:320px;overflow:auto;background:var(--rule-soft);padding:8px;border-radius:4px;margin:6px 0 0}
.fk-legacy{margin-top:14px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--old) 40%,transparent);border-radius:8px;background:color-mix(in srgb,var(--old) 6%,transparent)}
.fk-legacy h3{color:var(--old)}
.fk-hint{font-size:12px;color:var(--mute);margin-top:12px}
.fk-filter{display:flex;gap:8px;align-items:center;margin-bottom:10px}
.fk-filter input{background:transparent;color:var(--ink);border:1px solid var(--rule);border-radius:6px;padding:5px 9px;font:inherit;width:320px;max-width:100%}
.fk-table{width:100%;border-collapse:collapse}
.fk-table th{text-align:left;font-weight:500;font-size:12px;color:var(--mute);padding:4px 12px 4px 0;border-bottom:1px solid var(--rule)}
.fk-table td{padding:6px 12px 6px 0;border-bottom:1px solid var(--rule-soft);vertical-align:top}
.fk-conflict{border:1px solid color-mix(in srgb,var(--bad) 45%,transparent);border-radius:8px;padding:10px 12px;margin-bottom:12px}
.fk-conflict .acts{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.fk-mobile{display:grid;grid-template-columns:auto minmax(0,1fr);gap:24px;align-items:start}
.fk-mobile img{background:#fff;border-radius:6px;padding:4px;display:block}
.fk-mobile ol{margin:10px 0;padding-left:20px}
.fk-mobile li{margin:4px 0}
.fk-url{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.fk-url a{color:inherit;word-break:break-all}
@media (max-width:820px){.fk-cols,.fk-detail-grid,.fk-mobile{grid-template-columns:1fr}
  .fk-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.fk-stats>div:nth-child(3){padding-left:0;border-left:0}
  .fk-line{grid-template-columns:3px minmax(0,1fr) 84px 60px}.fk-line .wf,.fk-line .state{display:none}
  .fk-line,.fk-line.compact{grid-template-columns:8px minmax(0,1fr) 52px 58px}
  .fk-tabs{margin-left:0;width:100%;display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--rule)}
  .fk-tabs button{border-left:0;text-align:center;background:var(--paper)}}
@media (prefers-reduced-motion:no-preference){.fk-detail{animation:fk-in .14s ease-out}
  @keyframes fk-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}}`;
    const toDate = (v) => new Date(typeof v === "number" ? v * 1e3 : v);
    const ts = (v) => v ? toDate(v).toLocaleString() : "\u2014";
    function ago(v) {
      if (!v) return "\u2014";
      const s = Math.round((Date.now() - toDate(v).getTime()) / 1e3);
      if (s < 60) return "just now";
      if (s < 3600) return `${Math.floor(s / 60)} min ago`;
      if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
      if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
      return toDate(v).toLocaleDateString();
    }
    const When = ({ v }) => h("span", { title: ts(v) }, ago(v));
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
        "section",
        { className: "fk-sec" },
        h(
          "header",
          null,
          h("h2", null, props.title),
          props.meta ? h("span", { className: "mute" }, props.meta) : null,
          props.actions ? h("div", { className: "act" }, props.actions) : null
        ),
        props.children
      );
    }
    function useMore(items, n = 8) {
      const [all, setAll] = useState(false);
      if (items.length <= n) return [items, null];
      return [
        all ? items : items.slice(0, n),
        h("button", { className: "fk-more", onClick: () => setAll(!all) }, all ? "Show fewer" : `Show all ${items.length}`)
      ];
    }
    const Err = ({ msg }) => msg ? h("div", { className: "fk-err", role: "alert" }, msg) : null;
    const Loading = () => h("div", { className: "fk-empty" }, "Loading\u2026");
    const STATE = {
      complete: { word: "synced", color: "var(--ok)" },
      received: { word: "files still uploading", color: "var(--wait)" }
    };
    const stateOf = (k) => {
      var _a2;
      return (_a2 = STATE[k]) != null ? _a2 : { word: k.replace(/_/g, " "), color: "var(--bad)" };
    };
    const total = (o) => Object.values(o != null ? o : {}).reduce((a, n) => a + Number(n || 0), 0);
    function Track({ byStatus, conflicts }) {
      const entries = Object.entries(byStatus != null ? byStatus : {}).filter(([, n2]) => Number(n2) > 0).sort(([a], [b]) => a === "complete" ? -1 : b === "complete" ? 1 : 0);
      const n = total(byStatus);
      if (!n) return h("p", { className: "fk-empty" }, "Nothing synchronised yet. Records appear here once a phone syncs.");
      return h(
        "div",
        null,
        h(
          "div",
          { className: "fk-track", role: "img", "aria-label": entries.map(([k, c]) => `${c} ${stateOf(k).word}`).join(", ") },
          entries.map(([k, c]) => h("span", { key: k, style: { width: `${c / n * 100}%`, background: stateOf(k).color } }))
        ),
        h(
          "div",
          { className: "fk-legend" },
          entries.map(([k, c]) => h("span", { key: k }, h("i", { className: "fk-dot", style: { background: stateOf(k).color } }), h("b", null, c), stateOf(k).word)),
          conflicts > 0 ? h(
            "span",
            null,
            h("i", { className: "fk-dot", style: { background: "var(--bad)" } }),
            h("b", null, conflicts),
            conflicts === 1 ? "conflict to resolve" : "conflicts to resolve"
          ) : null
        )
      );
    }
    function Stats({ sync }) {
      const n = total(sync.records_by_sync_status);
      const cell = (label2, value, cls = "") => h("div", null, h("dt", null, label2), h("dd", { className: cls }, value));
      return h(
        "dl",
        { className: "fk-stats" },
        cell("Synchronised records", n),
        cell("Files still uploading", sync.attachments_outstanding, sync.attachments_outstanding ? "wait" : ""),
        cell(sync.open_conflicts ? "Open conflicts" : "No open conflicts", sync.open_conflicts, sync.open_conflicts ? "bad" : ""),
        cell("Last record received", h(When, { v: sync.last_received_at }), "small")
      );
    }
    function Overview() {
      var _a2;
      const [st, err] = useLoad(() => Promise.all([get("status"), get("sync/status"), get("records?limit=8"), get("workspaces")]));
      if (!st) return err ? h(Err, { msg: err }) : h(Loading);
      const [status, sync, recs, wss] = st;
      const own = ((_a2 = wss.workspaces) != null ? _a2 : []).filter((w) => !w.starter);
      return h(
        "div",
        null,
        h(
          Section,
          { title: "FieldKit status", actions: [
            h("span", { key: "v", className: "fk-chip" }, `version ${status.version}`),
            h("span", { key: "a", className: `fk-chip${status.app_built ? "" : " bad"}` }, status.app_built ? "phone app built" : "phone app NOT built")
          ] },
          h(Track, { byStatus: sync.records_by_sync_status, conflicts: sync.open_conflicts }),
          h(Stats, { sync }),
          h("p", { className: "fk-hint" }, "FieldKit collects and syncs. Ask your Hermes agent to read, analyse or summarise synced entries.")
        ),
        h(
          "div",
          { className: "fk-cols" },
          h(
            Section,
            { title: "Workspaces", meta: own.length || null },
            own.length ? h(Workspaces, { items: own }) : h("p", { className: "fk-empty" }, "No workspace yet. In Hermes, say: \u201CSet up FieldKit for my work.\u201D")
          ),
          h(Section, { title: "Recent records" }, h(RecordList, { records: recs.records, compact: true }))
        )
      );
    }
    function Workspaces({ items }) {
      const [shown, more] = useMore(items);
      return h("div", null, h(
        "table",
        { className: "fk-table" },
        h("thead", null, h("tr", null, h("th", null, "Workspace"), h("th", null, "Version"), h("th", null, "Updated"))),
        h("tbody", null, shown.map((w) => {
          var _a2;
          return h(
            "tr",
            { key: w.id },
            h("td", null, h("div", null, w.title), h("div", { className: "id" }, w.id)),
            h("td", null, (_a2 = w.published_version) != null ? _a2 : "draft"),
            h("td", { className: "mute" }, h(When, { v: w.updated_at }))
          );
        }))
      ), more);
    }
    function RecordList({ records, compact }) {
      const [open, setOpen] = useState(null);
      if (!(records == null ? void 0 : records.length)) return h("p", { className: "fk-empty" }, "No synchronised records yet.");
      return h("div", { className: "fk-ledger" }, records.map((r) => {
        const s = stateOf(r.sync_status), isOpen = open === r.id;
        return h(
          React.Fragment,
          { key: r.id },
          h(
            "div",
            { className: `fk-line${compact ? " compact" : ""}${isOpen ? " open" : ""}` },
            h("span", { className: "rail", style: { background: s.color }, title: s.word, "aria-hidden": true }),
            h(
              "div",
              { style: { minWidth: 0 } },
              h("div", { className: "t" }, r.workflow_title || r.workflow_id, r.subject ? h("span", { className: "sub" }, `  ${r.subject}`) : null),
              h("div", { className: "id" }, r.id)
            ),
            compact ? null : h("span", { className: "id wf", title: "Workflow id" }, r.workflow_id),
            h("span", { className: "state", style: { color: s.color } }, s.word),
            h("span", { className: "when" }, h("span", { className: "fk-sr" }, `${s.word}, received `), h(When, { v: r.received_at })),
            h("button", { className: "fk-btn", "aria-expanded": isOpen, onClick: () => setOpen(isOpen ? null : r.id) }, isOpen ? "Hide" : "Details")
          ),
          isOpen ? h(RecordDetail, { id: r.id }) : null
        );
      }));
    }
    const label = (v) => {
      var _a2;
      return v && typeof v === "object" ? (_a2 = v.en) != null ? _a2 : Object.values(v)[0] : v;
    };
    function answerText(v, f) {
      if (v === null || v === void 0 || v === "") return h("span", { className: "mute" }, "\u2014");
      const opt = (x) => {
        var _a2, _b2, _c;
        return (_c = label((_b2 = ((_a2 = f == null ? void 0 : f.options) != null ? _a2 : []).find((o) => o.value === x)) == null ? void 0 : _b2.label)) != null ? _c : String(x);
      };
      if (typeof v === "boolean") return v ? "Yes" : "No";
      if (Array.isArray(v)) {
        if (v.length && v.every((x) => x && typeof x === "object" && (x.attachment_id || x.id))) return `${v.length} file${v.length === 1 ? "" : "s"} (below)`;
        return v.every((x) => typeof x !== "object") ? v.map(opt).join(", ") : JSON.stringify(v);
      }
      if (typeof v === "object") return v.attachment_id ? "1 file (below)" : JSON.stringify(v);
      return opt(v);
    }
    function answerRows(answers, wf) {
      var _a2, _b2;
      const out = [], seen = /* @__PURE__ */ new Set();
      for (const f of (_a2 = wf == null ? void 0 : wf.fields) != null ? _a2 : []) if (f.id in (answers != null ? answers : {})) {
        out.push([f.id, String((_b2 = label(f.label)) != null ? _b2 : f.id), f]);
        seen.add(f.id);
      }
      for (const k of Object.keys(answers != null ? answers : {})) if (!seen.has(k)) out.push([k, k.replace(/_/g, " "), void 0]);
      return out;
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
      if (a.status !== "stored") return h("div", { className: "pending" }, `${noun} still uploading`, h("div", { className: "id" }, a.mime));
      if (!url) return h("div", { className: "pending" }, `Loading ${noun.toLowerCase()}\u2026`);
      const signed = a.signed_at ? `signed ${String(a.signed_at).replace("T", " ").slice(0, 16)}` : "";
      return h(
        "figure",
        null,
        String(a.mime).startsWith("audio/") ? h("audio", { controls: true, src: url }) : h(
          "a",
          { href: url, target: "_blank", rel: "noopener" },
          h("img", { src: url, alt: `${noun}${a.field_label ? `: ${a.field_label}` : ""}`, className: a.kind === "signature" ? "sig" : "" })
        ),
        h(
          "figcaption",
          null,
          h("div", null, a.field_label || noun),
          signed ? h("div", null, signed) : null,
          a.transcript ? h("div", null, `\u201C${a.transcript}\u201D`) : null
        )
      );
    }
    function RecordDetail({ id }) {
      var _a2, _b2, _c, _d, _e;
      const [data, err] = useLoad(async () => {
        const rec2 = await get(`records/${id}`);
        const [wf2, rep2, qs2] = await Promise.all([
          get(`workflows/${encodeURIComponent(rec2.workflow_id)}?version=${rec2.workflow_version}`).catch(() => null),
          get(`records/${id}/report`).catch(() => null),
          get(`records/${id}/questions`).catch(() => ({ questions: [] }))
        ]);
        return [rec2, wf2, rep2, qs2];
      }, [id]);
      if (!data) return h("div", { className: "fk-detail" }, err ? h(Err, { msg: err }) : "Loading\u2026");
      const [rec, wf, rep, qs] = data;
      const rows = answerRows(rec.answers, wf);
      const findings = (_b2 = (_a2 = rec.local_results) == null ? void 0 : _a2.findings) != null ? _b2 : [];
      const questions = (_c = qs == null ? void 0 : qs.questions) != null ? _c : [];
      return h(
        "div",
        { className: "fk-detail" },
        h(
          "div",
          { className: "fk-detail-grid" },
          h(
            "div",
            null,
            h("h3", null, "Answers"),
            rows.length ? h("dl", { className: "fk-kv" }, rows.map(([k, l, f]) => [h("dt", { key: `t${k}` }, l), h("dd", { key: `d${k}` }, answerText(rec.answers[k], f))])) : h("p", { className: "mute" }, "No answers recorded."),
            h("details", null, h("summary", null, "Raw answers (JSON)"), h("pre", null, JSON.stringify(rec.answers, null, 2)))
          ),
          h(
            "div",
            null,
            h("h3", null, ((_d = rec.attachments) == null ? void 0 : _d.length) ? rec.attachment_summary || `${rec.attachments.length} file(s)` : "Files"),
            ((_e = rec.attachments) == null ? void 0 : _e.length) ? h("div", { className: "fk-files" }, rec.attachments.map((a) => h(Attachment, { key: a.id, a }))) : h("p", { className: "mute" }, "No photos, voice notes or signatures."),
            h(
              "dl",
              { className: "fk-kv", style: { marginTop: 12 } },
              h("dt", null, "Completed on phone"),
              h("dd", null, ts(rec.completed_at)),
              h("dt", null, "Received by Hermes"),
              h("dd", null, ts(rec.received_at)),
              h("dt", null, "Revision"),
              h("dd", null, rec.revision),
              rec.workspace_id ? [h("dt", { key: "wt" }, "Workspace"), h("dd", { key: "wd", className: "id" }, rec.workspace_id)] : null,
              rec.device_id ? [h("dt", { key: "dt" }, "Device"), h("dd", { key: "dd", className: "id" }, rec.device_id)] : null
            )
          )
        ),
        findings.length ? h(
          "div",
          { className: "fk-legacy" },
          h("h3", null, "Phone findings (FieldKit before 0.3)"),
          findings.map((f, i) => h("div", { key: i }, h(Sev, { s: f.severity }), " ", f.label, f.detail ? `: ${f.detail}` : ""))
        ) : null,
        questions.length ? h(
          "div",
          { className: "fk-legacy" },
          h("h3", null, "Questions answered by FieldKit before 0.3"),
          questions.map((q) => h(
            "div",
            { key: q.id, style: { margin: "6px 0" } },
            h("div", null, h("b", null, q.question), h("span", { className: "mute" }, `  ${q.status}`)),
            q.answer ? h("div", null, q.answer.answer) : null
          ))
        ) : null,
        rep ? h("div", { className: "fk-legacy" }, h("h3", null, "Report from FieldKit before 0.3"), h(ReportView, { r: rep })) : null,
        h("p", { className: "fk-hint" }, "To analyse this entry, ask your Hermes agent. It can open the photos and voice notes.")
      );
    }
    const sevColor = { critical: "var(--bad)", high: "var(--bad)", medium: "var(--wait)", low: "var(--ok)", info: "var(--mute)" };
    const Sev = ({ s }) => {
      var _a2;
      return h("b", { style: { color: (_a2 = sevColor[s]) != null ? _a2 : void 0, fontSize: 12 } }, s);
    };
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
              { key: e.attachment_id },
              e.transcript ? `\u201C${e.transcript}\u201D (${e.transcript_source === "device" ? "transcribed on the phone" : "transcribed by Hermes"})` : `Not transcribed: ${(_a3 = e.transcript_error) != null ? _a3 : "unknown reason"}`
            );
          })
        ),
        att.evidence.filter((e) => e.kind === "signature").map((e) => {
          var _a3;
          return h(
            "div",
            { key: e.attachment_id, style: { marginTop: 4 } },
            `${e.field_label || "Signature"}${e.signed_at ? `, signed ${String(e.signed_at).replace("T", " ").slice(0, 16)}` : ""}: file ${(_a3 = INTEGRITY[e.integrity]) != null ? _a3 : e.integrity}`,
            e.stored && h("div", { className: "fk-files" }, h(Attachment, { a: { id: e.attachment_id, mime: e.mime, status: "stored", kind: "signature" } }))
          );
        })
      );
    }
    function ReportView({ r }) {
      var _a2, _b2, _c, _d, _e, _f, _g, _h;
      const list = (title, items, fn) => (items == null ? void 0 : items.length) > 0 && h("div", { style: { marginTop: 6 } }, h("b", null, title), h("ul", { style: { margin: "2px 0", paddingLeft: 18 } }, items.map((x, k) => h("li", { key: k }, fn(x)))));
      return h(
        "div",
        null,
        h("div", { className: "mute", style: { fontSize: 12 } }, `Version ${r.version}, ${ts(r.generated_at)}, by ${[r.generated_by, r.provider, r.model].filter(Boolean).join(" ")}`),
        r.requires_review && h("div", { style: { color: "var(--wait)", fontWeight: 600 } }, `Requires human review${r.review_reason ? `: ${r.review_reason}` : ""}`),
        ((_a2 = r.decision) == null ? void 0 : _a2.outcome) && h(
          "div",
          { style: { margin: "6px 0" } },
          h("b", null, "Decision: "),
          ((_c = ((_b2 = r.decision_scale) != null ? _b2 : []).find((d) => d.id === r.decision.outcome)) == null ? void 0 : _c.label) || r.decision.outcome,
          `, confidence ${r.decision.confidence}`,
          typeof r.decision.deadline_days === "number" ? `, within ${r.decision.deadline_days} day(s)` : "",
          r.decision.escalate_to ? `, escalate to ${r.decision.escalate_to}` : "",
          h("div", null, r.decision.rationale)
        ),
        h("p", { style: { margin: "6px 0" } }, r.summary),
        list("Next actions", r.next_actions, (a) => [
          a.action,
          a.who ? ` (${a.who}${typeof a.by_when_days === "number" ? `, within ${a.by_when_days} day(s)` : ""})` : "",
          h("div", { key: "v", className: "mute", style: { fontSize: 12 } }, `Verify: ${a.verify_by}. ${a.origin === "ai_suggestion" ? "AI suggestion" : `From workspace ${a.origin}`}`)
        ]),
        list("Uncertain", r.uncertainty, (u) => `${u.unknown}: ${u.how_to_resolve}`),
        ((_e = (_d = r.quality) == null ? void 0 : _d.problems) == null ? void 0 : _e.length) > 0 && h("div", { style: { color: "var(--wait)" } }, `Quality checks not passed: ${r.quality.problems.join("; ")}`),
        ((_f = r.images) == null ? void 0 : _f.note) && h("div", { style: { margin: "6px 0" } }, h("b", null, r.images.analyzed === false ? "Photos not analysed: " : "Photos: "), r.images.note),
        ((_h = (_g = r.attachments) == null ? void 0 : _g.evidence) == null ? void 0 : _h.length) > 0 && h(Evidence, { att: r.attachments }),
        list("Issues", r.issues, (i) => [h(Sev, { key: "s", s: i.severity }), ` ${i.title}: ${i.evidence}`]),
        list("Missing information", r.missing_information, (m) => m),
        list("Suggested actions", r.suggested_actions, (a) => `${a.action} (${a.priority})`),
        list("References", r.references, (x) => `${x.title}${x.source ? `, ${x.source}` : ""}`)
      );
    }
    function Records() {
      var _a2;
      const [wf, setWf] = useState("");
      const [q, setQ] = useState("");
      useEffect(() => {
        const t = setTimeout(() => setQ(wf.trim()), 250);
        return () => clearTimeout(t);
      }, [wf]);
      const [data, err] = useLoad(() => get(`records?limit=100${q ? `&workflow_id=${encodeURIComponent(q)}` : ""}`), [q]);
      const recs = (_a2 = data == null ? void 0 : data.records) != null ? _a2 : [];
      const ids = Array.from(new Set(recs.map((r) => r.workflow_id)));
      return h(
        Section,
        { title: "Synchronised records", meta: data ? recs.length === 100 ? "latest 100, newest first" : `${recs.length}, newest first` : null },
        h(
          "div",
          { className: "fk-filter" },
          h("input", {
            placeholder: "Filter by workflow id, e.g. equipment-inspection",
            value: wf,
            list: "fk-wf-ids",
            "aria-label": "Filter by workflow id",
            onChange: (e) => setWf(e.target.value)
          }),
          h("datalist", { id: "fk-wf-ids" }, ids.map((i) => h("option", { key: i, value: i }))),
          wf ? h("button", { className: "fk-btn", onClick: () => setWf("") }, "Clear") : null
        ),
        h(Err, { msg: err }),
        data ? h(RecordList, { records: recs }) : err ? null : h(Loading)
      );
    }
    function Conflict({ c, onDone }) {
      var _a2, _b2, _c, _d;
      const [server] = useLoad(() => get(`records/${c.record_id}`).catch(() => null), [c.record_id]);
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState(null);
      const phone = (_c = (_b2 = (_a2 = c.client_payload) == null ? void 0 : _a2.record) == null ? void 0 : _b2.answers) != null ? _c : {};
      const mine = (_d = server == null ? void 0 : server.answers) != null ? _d : {};
      const keys = Array.from(/* @__PURE__ */ new Set([...Object.keys(mine), ...Object.keys(phone)]));
      const resolve = (resolution) => {
        setBusy(true);
        setErr(null);
        post(`sync/conflicts/${c.id}/resolve`, { resolution }).then(onDone, (e) => {
          var _a3;
          setErr(String((_a3 = e == null ? void 0 : e.message) != null ? _a3 : e));
          setBusy(false);
        });
      };
      const txt = (v) => v === void 0 ? "\u2014" : typeof v === "string" ? v : JSON.stringify(v);
      return h(
        "div",
        { className: "fk-conflict" },
        h(
          "div",
          null,
          h("b", null, c.form_title || "Record"),
          c.subject ? h("span", null, `  ${c.subject}`) : null,
          c.workspace_title ? h("span", { className: "mute" }, `  in ${c.workspace_title}`) : null,
          c.completed_at ? h("span", { className: "mute" }, `  ${new Date(c.completed_at).toLocaleString()}`) : null
        ),
        h("div", { className: "id" }, c.record_id),
        h("p", { className: "mute" }, `The phone edited revision ${c.base_revision}; Hermes already has revision ${c.server_revision}. Choose which copy to keep.`),
        server ? h(
          "table",
          { className: "fk-table", style: { marginTop: 8 } },
          h("thead", null, h("tr", null, h("th", null, "Answer"), h("th", null, "Hermes copy"), h("th", null, "Phone copy"))),
          h("tbody", null, keys.map((k) => {
            const diff = JSON.stringify(mine[k]) !== JSON.stringify(phone[k]);
            return h(
              "tr",
              { key: k, style: diff ? { background: "color-mix(in srgb,var(--wait) 16%,transparent)" } : void 0 },
              h("td", { className: "mute" }, k.replace(/_/g, " ")),
              h("td", null, txt(mine[k])),
              h("td", null, txt(phone[k]))
            );
          }))
        ) : h("pre", null, JSON.stringify(phone, null, 2)),
        h(Err, { msg: err }),
        h(
          "div",
          { className: "acts" },
          h("button", { className: "fk-btn", disabled: busy, onClick: () => resolve("keep_server") }, "Keep server version"),
          h("button", { className: "fk-btn solid", disabled: busy, onClick: () => resolve("use_client") }, "Use phone version")
        )
      );
    }
    function Devices({ items }) {
      const [shown, more] = useMore(items);
      return h("div", null, h(
        "table",
        { className: "fk-table" },
        h("thead", null, h("tr", null, h("th", null, "Device"), h("th", null, "Last seen"), h("th", null, "Device id"))),
        h("tbody", null, shown.map((d) => h(
          "tr",
          { key: d.id },
          h("td", null, d.label || h("span", { className: "mute" }, "Unnamed device")),
          h("td", null, h(When, { v: d.last_seen })),
          h("td", { className: "id" }, d.id)
        )))
      ), more);
    }
    function Sync() {
      const [data, err, reload] = useLoad(() => Promise.all([get("sync/status"), get("sync/conflicts")]));
      if (!data) return err ? h(Err, { msg: err }) : h(Loading);
      const [st, cf] = data;
      return h(
        "div",
        null,
        h(
          Section,
          { title: "Synchronisation", actions: h("button", { className: "fk-btn", onClick: reload }, "Refresh") },
          h(Track, { byStatus: st.records_by_sync_status, conflicts: st.open_conflicts }),
          h(Stats, { sync: st }),
          h(Err, { msg: err })
        ),
        h(
          Section,
          { title: "Conflicts", meta: cf.conflicts.length ? `${cf.conflicts.length} open` : null },
          cf.conflicts.length ? cf.conflicts.map((c) => h(Conflict, { key: c.id, c, onDone: reload })) : h("p", { className: "fk-empty" }, "No open conflicts. Edits from every phone have been merged.")
        ),
        h(
          Section,
          { title: "Devices", meta: st.devices.length || null },
          st.devices.length ? h(Devices, { items: st.devices }) : h("p", { className: "fk-empty" }, "No phone has synced yet. Open the Mobile Access tab to set one up.")
        )
      );
    }
    function Mobile() {
      const url = appUrl();
      const [copied, setCopied] = useState(false);
      const qr = qrcode_default(0, "M");
      qr.addData(url);
      qr.make();
      const copy = () => {
        var _a2;
        return (_a2 = navigator.clipboard) == null ? void 0 : _a2.writeText(url).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }, () => void 0);
      };
      return h(
        Section,
        { title: "Open FieldKit on a phone" },
        h(
          "div",
          { className: "fk-mobile" },
          h("img", { src: qr.createDataURL(5, 4), alt: "QR code for the FieldKit app" }),
          h(
            "div",
            null,
            h(
              "div",
              { className: "fk-url" },
              h("a", { href: url, target: "_blank", rel: "noopener" }, url),
              h("button", { className: "fk-btn", onClick: copy }, copied ? "Copied" : "Copy link")
            ),
            h(
              "ol",
              null,
              h("li", null, "Scan the code (or open the link) on the phone while online and sign in to Hermes."),
              h("li", null, "Open your workspace and tap \u201CDownload everything for offline\u201D. Optional: OCR and translation packs in Offline Packs."),
              h("li", null, "Add to Home Screen. Android: menu, then Install app. iPhone: Share, then Add to Home Screen."),
              h("li", null, "Check the Offline readiness card on Home. After that it works with no connection.")
            ),
            h("p", { className: "fk-hint" }, "Service workers need HTTPS: the phone must reach this dashboard over https:// (or localhost).")
          )
        )
      );
    }
    const TABS = [
      ["Overview", Overview],
      ["Records", Records],
      ["Synchronization", Sync],
      ["Mobile Access", Mobile]
    ];
    function FieldKitPage() {
      var _a2;
      const [tab, setTab] = useState("Overview");
      const View = ((_a2 = TABS.find(([n]) => n === tab)) != null ? _a2 : TABS[0])[1];
      return h(
        "div",
        { className: "fk" },
        h("style", null, CSS),
        h(
          "div",
          { className: "fk-top" },
          h("span", { className: "mute" }, "Observations collected offline on phones, synced to Hermes"),
          h(
            "nav",
            { className: "fk-tabs", "aria-label": "FieldKit sections" },
            TABS.map(([n]) => h("button", { key: n, type: "button", "aria-pressed": n === tab, onClick: () => setTab(n) }, n))
          )
        ),
        h(View, null)
      );
    }
    (_b = (_a = window.__HERMES_PLUGINS__) == null ? void 0 : _a.register) == null ? void 0 : _b.call(_a, "fieldkit", FieldKitPage);
  })();
})();
