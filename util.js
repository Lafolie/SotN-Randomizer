(function(self) {

  let constants
  let enemies
  let errors
  let extension
  let items
  let relics
  let fs
  let sha256

  if (self) {
    constants = self.sotnRando.constants
    enemies = self.sotnRando.enemies
    errors = self.sotnRando.errors
    extension = self.sotnRando.extension
    items = self.sotnRando.items
    relics = self.sotnRando.relics
    sha256 = function(input) {
      return self.sjcl.codec.hex.fromBits(self.sjcl.hash.sha256.hash(input))
    }
  } else {
    constants = require('./constants')
    enemies = require('./enemies')
    errors = require('./errors')
    extension = require('./extension')
    items = require('./items')
    relics = require('./relics')
    const crypto = require('crypto')
    fs = require('fs')
    sha256 = function(input) {
      return crypto.createHash('sha256').update(input).digest().toString('hex')
    }
  }

  function assert(value, message) {
    if (!value) {
      message = message || 'Assertion failed: ' + value
      throw new errors.AssertionError(message)
    }
  }

  assert.equal = function equal(actual, expected, message) {
    if (actual !== expected) {
      message = message || 'Assertion failed: ' + actual + ' === ' + expected
      throw new errors.AssertionError(message)
    }
  }

  assert.notEqual = function equal(actual, expected, message) {
    if (actual === expected) {
      message = message || 'Assertion failed: ' + actual + ' !== ' + expected
      throw new errors.AssertionError(message)
    }
  }

  assert.oneOf = function equal(actual, expected, message) {
    if (expected.indexOf(actual) === -1) {
      message = message || 'Assertion failed: ' + actual + ' one of '
        + expected.join(', ')
      throw new errors.AssertionError(message)
    }
  }

  function roomCount(zone) {
    let layout = zone.readUInt32LE(0x10) - 0x80180000
    let rooms = 0
    while (zone[layout] !== 0x40) {
      rooms++
      layout += 8
    }
    return rooms
  }

  function shopTileFilter(tile) {
    return tile.shop
  }

  function dropTileFilter(tile) {
    return 'enemy' in tile || tile.librarian
  }

  function rewardTileFilter(tile) {
    return tile.reward
  }

  function candleTileFilter(tile) {
    return typeof(tile.candle) !== 'undefined'
  }

  function tankTileFilter(tile) {
    return tile.tank
  }

  function mapTileFilter(tile) {
    return !shopTileFilter(tile)
      && !tankTileFilter(tile)
      && !rewardTileFilter(tile)
      && !candleTileFilter(tile)
      && !dropTileFilter(tile)
  }

  function nonProgressionFilter(item) {
    return !item.progression
  }

  function tilesFilter(item) {
    return Array.isArray(item.tiles)
  }

  function itemTileFilter(tileFilter) {
    return function(item) {
      return item.tiles && item.tiles.some(tileFilter)
    }
  }

  function tileIdOffsetFilter(item) {
    return [
      constants.TYPE.WEAPON1,
      constants.TYPE.WEAPON2,
      constants.TYPE.SHIELD,
      constants.TYPE.HELMET,
      constants.TYPE.ARMOR,
      constants.TYPE.CLOAK,
      constants.TYPE.ACCESSORY,
      constants.TYPE.USABLE,
    ].indexOf(item.type) !== -1
  }

  function itemFromName(name, from) {
    from = from || items
    return from.filter(function(item) {
      return item.name === name
    })[0]
  }

  function itemFromTileId(items, id) {
    return items.filter(function(item) {
      if (id > constants.tileIdOffset) {
        return item.id === (id - constants.tileIdOffset)
          && tileIdOffsetFilter(item)
      }
      return item.id === id
    })[0]
  }

  function tileValue(item, tile) {
    if (!tile) {
      tile = {}
    }
    if (tile.noOffset) {
      return item.id
    }
    let id = ((tile.candle || 0x00) << 8) | item.id
    if (tile.shop) {
      // Apply offset for some item types in the shop menu.
      switch (item.type) {
      case constants.TYPE.HELMET:
      case constants.TYPE.ARMOR:
      case constants.TYPE.CLOAK:
      case constants.TYPE.ACCESSORY:
        id += constants.equipIdOffset
        break
      }
    } else if (tile.candle && item.id >= constants.tileIdOffset) {
      id += constants.tileIdOffset
    } else {
      // Apply tile offset for some tile items.
      switch (item.type) {
      case constants.TYPE.POWERUP:
      case constants.TYPE.HEART:
      case constants.TYPE.GOLD:
      case constants.TYPE.SUBWEAPON:
        break
      default:
        id += constants.tileIdOffset
        break
      }
    }
    return id
  }

  function getRooms(zone) {
    // Get room count.
    const rooms = roomCount(zone)
    const layouts = zone.readUInt32LE(0x20) - 0x80180000
    const room = zone.readUInt32LE(0x10) - 0x80180000
    const ids = []
    for (let i = 0; i < rooms; i++) {
      const gfxId = zone[room + 0x8 * i + 0x5]
      if (gfxId == 0xff) {
        // Parsing the tiles layout data doesn't work for loading zone like
        // the other rooms, so they must be skipped.
        ids.push(undefined)
        continue
      }
      ids.push(zone[room + 0x8 * i + 0x4])
    }
    return ids.map(function(id) {
      if (id !== undefined) {
        // Get pointer to layout data.
        const offset = zone.readUInt32LE(layouts + 0x8 * id) - 0x80180000
        // Parse the layout data.
        const tiles  = zone.readUInt32LE(offset) - 0x80180000
        const defs   = zone.readUInt32LE(offset + 0x4) - 0x80180000
        const dims   = zone.readUInt32LE(offset + 0x8) & 0xffffff
        const endy   = dims >> 18
        const endx   = (dims >> 12) & 0x3f
        const starty = (dims >> 6) & 0x3f
        const startx = dims & 0x3f
        const width  = endx - startx + 1
        const height = endy - starty + 1
        const flags  = zone[8]
        return {
          id: id,
          tiles: tiles,
          defs: defs,
          x: startx,
          y: starty,
          width: width,
          height: height,
          flags: flags,
        }
      }
    })
  }

  function tileData(zone) {
    return getRooms(zone).map(function(room) {
      if (room !== undefined) {
        const map = Array(16 * room.height)
        for (let y = 0; y < 16 * room.height; y++) {
          map[y] = Array(16 * room.width)
          for (let x = 0; x < 16 * room.width; x++) {
            const index = zone.readUInt16LE(room.tiles + 0x2 * (16 * room.width * y + x))
            if (index) {
              map[y][x] = zone.readUInt32LE(room.defs + 0x20 * index)
            } else {
              map[y][x] = 0
            }
          }
        }
        return map
      }
    })
  }

  function entityData(zone) {
    // Get rooms.
    const rooms = getRooms(zone)
    // Get entity layout IDs.
    const room = zone.readUInt32LE(0x10) - 0x80180000
    const ids = []
    for (let i = 0; i < rooms.length; i++) {
      ids.push(zone[room + 0x4 + 0x8 * i + 0x3])
    }
    // Get pointers to sorted tile layout structures.
    const enter = zone.readUInt32LE(0x0c) - 0x80180000
    const offsets = [
      zone.readUInt16LE(enter + 0x1c),
      zone.readUInt16LE(enter + 0x28),
    ]
    // Get sorted lists.
    const entities = Array(rooms.length).fill(null).map(function() {
      return {}
    })
    offsets.forEach(function(offset) {
      for (let i = 0; i < rooms.length; i++) {
        const room = rooms[i]
        if (!room) {
          continue
        }
        const ptr = zone.readUInt32LE(offset + 4 * ids[i]) - 0x80180000
        let entitiy
        let count = 0
        while (true) {
          const p = ptr + 10 * count++
          entity = zone.slice(p, p + 10)
          const key = bufToHex(entity)
          const header = entity.readUInt32LE()
          if (header == 0xffffffff) {
            break
          } else if (header == 0xfffefffe) {
            continue
          }
          entities[i][key] = entities[i][key] || []
          entities[i][key].push(p)
        }
      }
    })
    return entities.map(function(room) {
      return Object.getOwnPropertyNames(room).map(function(key) {
        const bytes = key.match(/[0-9a-f]{2}/g).map(function(byte) {
          return parseInt(byte, 16)
        })
        return {
          data: Buffer.from(bytes),
          addresses: room[key],
        }
      })
    })
  }

  function romOffset(zone, address) {
    return zone.pos + address + Math.floor(address / 0x800) * 0x130
  }

  function bufToHex(buf) {
    return Array.from(buf).map(function(byte) {
      return ('00' + byte.toString(16)).slice(-2)
    }).join('')
  }

  function numToHex(num, width) {
    let sign = 1
    if (num < 0) {
      sign = -1
      num *= -1
    }
    if (width === undefined) {
      width = 2 * Math.ceil(num.toString(16).length / 2)
    }
    const zeros = Array(width).fill('0').join('')
    const hex = (zeros + num.toString(16)).slice(-width)
    return (sign < 0 ? '-' : '') + '0x' + hex
  }

  function checked(file, writes) {
    if (file) {
      this.file = file
    }
    this.writes = writes || {}
  }

  function checkAddressRange(address) {
    if (address < 0xffff || address > 0xffffffff || Number.isNaN(address)) {
      throw Error('bad address: ' + numToHex(address))
    }
  }

  checked.prototype.writeChar = function writeChar(address, val) {
    checkAddressRange(address)
    if (this.file) {
      if (typeof(this.file) === 'object') {
        this.file[address] = val & 0xff
      } else {
        const buf = Buffer.from([val & 0xff])
        fs.writeSync(this.file, buf, 0, 1, address)
      }
    }
    this.writes[address] = val & 0xff
    return address + 1
  }

  checked.prototype.writeShort = function writeShort(address, val) {
    checkAddressRange(address)
    const bytes = [
      val & 0xff,
      (val >>> 8) & 0xff,
    ]
    if (this.file) {
      if (typeof(this.file) === 'object') {
        for (let i = 0; i < 2; i++) {
          this.file[address + i] = bytes[i]
        }
      } else {
        const buf = Buffer.from(bytes)
        fs.writeSync(this.file, buf, 0, 2, address)
      }
    }
    for (let i = 0; i < 2; i++) {
      this.writes[address + i] = bytes[i]
    }
    return address + 2
  }

  checked.prototype.writeWord = function writeShort(address, val) {
    checkAddressRange(address)
    const bytes = [
      val & 0xff,
      (val >>> 8) & 0xff,
      (val >>> 16) & 0xff,
      (val >>> 24) & 0xff,
    ]
    if (this.file) {
      if (typeof(this.file) === 'object') {
        for (let i = 0; i < 4; i++) {
          this.file[address + i] = bytes[i]
        }
      } else {
        const buf = Buffer.from(bytes)
        fs.writeSync(this.file, buf, 0, 4, address)
      }
    }
    for (let i = 0; i < 4; i++) {
      this.writes[address + i] = bytes[i]
    }
    return address + 4
  }

  checked.prototype.apply = function apply(checked) {
    const self = this
    Object.getOwnPropertyNames(checked.writes).forEach(function(address) {
      self.writeChar(parseInt(address), checked.writes[address])
    })
  }

  checked.prototype.sum = function sum() {
    const state = JSON.stringify(this.writes)
    let hex = sha256(state)
    let zeros = 0
    while (hex.length > 3 && hex[zeros] === '0') {
      zeros++
    }
    return parseInt(hex.slice(zeros, zeros + 3), 16)
  }

  function optionsFromString(randomize) {
    const options = {}
    let i = 0
    while (i < randomize.length) {
      let c = randomize[i++]
      switch (c) {
      case 'p': {
        // Check for an argument.
        if (randomize[i] !== ':') {
          throw new Error('Expected argument')
        }
        let arg
        let start
        // Parse the arg name.
        start = ++i
        while (i < randomize.length && randomize[i] !== ',') {
          i++
        }
        arg = randomize.slice(start, i)
        if (!arg.length) {
          throw new Error('Expected argument')
        }
        options.preset = arg
        if (randomize[i] === ',') {
          i++
        }
        break
      }
      case 'd': {
        let enemyDrops = options.enemyDrops || true
        // Check for an argument.
        if (randomize[i] === ':') {
          i++
          let args = 0
          while (i < randomize.length && randomize[i] !== ',') {
            let arg
            let start
            // Parse the arg name.
            start = i
            while (i < randomize.length
                   && [',', ':'].indexOf(randomize[i]) === -1) {
              i++
            }
            arg = randomize.slice(start, i)
            if (!arg.length) {
              throw new Error('Expected argument')
            }
            const dashIndex = arg.lastIndexOf('-')
            let level
            if (dashIndex !== -1) {
              level = parseInt(arg.slice(dashIndex + 1))
              arg = arg.slice(0, dashIndex)
            }
            let enemyName
            if (arg === '*' || arg === constants.GLOBAL_DROP) {
              enemyName = arg
            } else {
              let enemy
              const matches = enemies.filter(function(enemy) {
                let name = enemy.name.replace(/[^a-zA-Z0-9]/g, '')
                name = name.toLowerCase()
                return name === arg.toLowerCase()
              })
              if (matches.length > 1 && typeof(level) !== 'undefined') {
                enemy = matches.filter(function(enemy) {
                  return enemy.level === level
                })[0]
              } else {
                enemy = matches[0]
              }
              if (!enemy) {
                throw new Error('Unknown enemy: ' + arg)
              }
              enemyName = enemy.name.replace(/[^a-zA-Z0-9]/g, '')
              if (matches.length > 1 && matches[0] !== enemy) {
                enemyName += '-' + enemy.level
              }
            }
            if (typeof(enemyDrops) !== 'object') {
              enemyDrops = {}
            }
            enemyDrops[enemyName] = []
            if (randomize[i] === ':') {
              start = ++i
              while (i < randomize.length
                     && [',', ':'].indexOf(randomize[i]) === -1) {
                i++
              }
              arg = randomize.slice(start, i)
              arg.split('-').forEach(function(arg, index)  {
                if (enemyName !== constants.GLOBAL_DROP && index > 1) {
                  throw new Error('Too many drops for enemy: ' + enemy.name)
                }
                if (arg) {
                  const item = items.filter(function(item) {
                    let name = item.name.replace(/[^a-zA-Z0-9]/g, '')
                    name = name.toLowerCase()
                    return name === arg.toLowerCase()
                  })[0]
                  if (!item) {
                    throw new Error('Unknown item: ' + arg)
                  }
                  const itemName = item.name
                  enemyDrops[enemyName].push(itemName)
                } else {
                  enemyDrops[enemyName].push('')
                }
              })
            }
            if (randomize[i] === ':') {
              i++
            }
            args++
          }
          if (randomize[i] === ',') {
            i++
          }
          if (!args) {
            throw new Error('Expected arguments')
          }
        } else if (typeof(enemyDrops) === 'undefined') {
          // Otherwise it's just turning on drop randomization.
          enemyDrops = true
        }
        if (typeof(enemyDrops) === 'object'
            && Object.getOwnPropertyNames(enemyDrops).length === 0) {
          enemyDrops = true
        }
        options.enemyDrops = enemyDrops
        break
      }
      case 'e': {
        let startingEquipment = options.startingEquipment || true
        // Check for an argument.
        if (randomize[i] === ':') {
          i++
          let args = 0
          while (i < randomize.length && randomize[i] !== ',') {
            let arg
            let start
            // Parse the arg name.
            start = i
            while (i < randomize.length
                   && [',', ':'].indexOf(randomize[i]) === -1) {
              i++
            }
            arg = randomize.slice(start, i)
            if (!arg.length) {
              throw new Error('Expected argument')
            }
            if (['r', 'l', 'h', 'b', 'c', 'o', 'a', 'x'].indexOf(arg) === -1) {
              throw new Error('Unknown equipment slot: ' + arg)
            }
            const slot = arg
            if (randomize[i] !== ':') {
              throw new Error('Expected argument')
            }
            start = ++i
            while (i < randomize.length
                   && [',', ':'].indexOf(randomize[i]) === -1) {
              i++
            }
            arg = randomize.slice(start, i)
            let itemName = ''
            if (arg.length) {
              const item = items.filter(function(item) {
                let name = item.name.replace(/[^a-zA-Z0-9]/g, '')
                name = name.toLowerCase()
                return name === arg.toLowerCase()
              })[0]
              if (!item) {
                throw new Error('Unknown item: ' + arg)
              }
              itemName = item.name
              let types
              switch (slot) {
              case 'r':
                types = [
                  constants.TYPE.WEAPON1,
                  constants.TYPE.WEAPON2,
                  constants.TYPE.SHIELD,
                  constants.TYPE.USABLE,
                ]
                if (types.indexOf(item.type) === -1) {
                  throw new Error('Cannot equip ' + item.name
                                  + ' in right hand')
                }
                if (startingEquipment.l
                    && item.type === constants.TYPE.WEAPON2) {
                  throw new Error('Cannot equip ' + item.name
                                  + ' and a two handed weapon')
                }
                break
              case 'l':
                types = [
                  constants.TYPE.WEAPON1,
                  constants.TYPE.SHIELD,
                  constants.TYPE.USABLE,
                ]
                if (types.indexOf(item.type) === -1) {
                  throw new Error('Cannot equip ' + item.name
                                  + ' in left hand')
                }
                if (startingEquipment.r
                    && startingEquipment.r.type === constants.TYPE.WEAPON2) {
                  throw new Error('Cannot equip ' + item.name
                                  + ' and a two handed weapon')
                }
                break
              case 'h':
                if (item.type !== constants.TYPE.HELMET) {
                  throw new Error('Cannot equip ' + item.name + ' on head')
                }
                break
              case 'b':
                if (item.type !== constants.TYPE.ARMOR) {
                  throw new Error('Cannot equip ' + item.name + ' on body')
                }
                break
              case 'c':
                if (item.type !== constants.TYPE.CLOAK) {
                  throw new Error('Cannot equip ' + item.name + ' as cloak')
                }
                break
              case 'o':
                if (item.type !== constants.TYPE.ACCESSORY) {
                  throw new Error('Cannot equip ' + item.name + ' as other')
                }
                break
              case 'a':
                if (item.type !== constants.TYPE.ARMOR) {
                  throw new Error('Cannot give ' + item.name + ' as armor')
                }
                break
              case 'x':
                if (item.type !== constants.TYPE.ACCESSORY) {
                  throw new Error('Cannot equip ' + item.name + ' as other')
                }
                break
              }
            }
            if (typeof(startingEquipment) !== 'object') {
              startingEquipment = {}
            }
            startingEquipment[slot] = itemName
            if (randomize[i] === ':') {
              i++
            }
            args++
          }
          if (randomize[i] === ',') {
            i++
          }
          if (!args) {
            throw new Error('Expected argument')
          }
        } else if (typeof(startingEquipment) === 'undefined') {
          // Otherwise it's just turning on equipment randomization.
          startingEquipment = true
        }
        if (typeof(startingEquipment) === 'object'
            && Object.getOwnPropertyNames(startingEquipment).length === 0) {
          startingEquipment = true
        }
        options.startingEquipment = startingEquipment
        break
      }
      case 'i': {
        let itemLocations = options.itemLocations || true
        // Check for an argument.
        if (randomize[i] === ':') {
          i++
          let args = 0
          while (i < randomize.length && randomize[i] !== ',') {
            let arg
            let start
            // Parse the arg name.
            start = i
            while (i < randomize.length
                   && [',', ':'].indexOf(randomize[i]) === -1) {
              i++
            }
            arg = randomize.slice(start, i)
            if (!arg.length) {
              throw new Error('Expected argument')
            }
            if (arg !== '*' && !(arg in constants.ZONE)) {
              throw new Error('Unknown zone: ' + arg)
            }
            const zone = arg
            if (typeof(itemLocations) !== 'object') {
              itemLocations = {}
            }
            if (randomize[i] !== ':') {
              throw new Error('Expected argument')
            }
            start = ++i
            while (i < randomize.length
                   && [',', ':'].indexOf(randomize[i]) === -1) {
              i++
            }
            arg = randomize.slice(start, i)
            if (!arg.length) {
              throw new Error('Expected argument')
            }
            let itemName
            let index
            if (arg === '*') {
              itemName = arg
              index = 0
            } else {
              const dashIndex = arg.lastIndexOf('-')
              if (dashIndex === -1) {
                index = 0
              } else {
                index = parseInt(arg.slice(dashIndex + 1)) - 1
                if (index < 0) {
                  throw new Error('Unknown item number: '
                                  + arg.slice(dashIndex + 1))
                }
                arg = arg.slice(0, dashIndex)
              }
              const item = items.filter(function(item) {
                let name = item.name.replace(/[^a-zA-Z0-9]/g, '')
                name = name.toLowerCase()
                return name === arg.toLowerCase()
              })[0]
              if (!item) {
                throw new Error('Unknown item: ' + arg)
              }
              itemName = item.name
              const tile = item.tiles && item.tiles.filter(function(tile) {
                if (typeof(tile.zones) !== 'undefined') {
                  return tile.zones.indexOf(constants.ZONE[zone]) !== -1
                }
              })[index]
              if (!tile) {
                throw new Error('Item not found in zone: ' + arg)
              }
            }
            if (randomize[i] !== ':') {
              throw new Error('Expected argument')
            }
            start = ++i
            while (i < randomize.length
                   && [',', ':'].indexOf(randomize[i]) === -1) {
              i++
            }
            arg = randomize.slice(start, i)
            if (!arg.length) {
              throw new Error('Expected argument')
            }
            const replace = items.filter(function(item) {
              let name = item.name.replace(/[^a-zA-Z0-9]/g, '')
              name = name.toLowerCase()
              return name === arg.toLowerCase()
            })[0]
            if (!replace) {
              throw new Error('Unknown item: ' + arg)
            }
            const replaceName = replace.name
            itemLocations[zone] = itemLocations[zone] || {}
            let map = itemLocations[zone][itemName] || {}
            map[index] = replaceName
            itemLocations[zone][itemName] = map
            if (randomize[i] === ':') {
              i++
            }
            args++
          }
          if (randomize[i] === ',') {
            i++
          }
          if (!args) {
            throw new Error('Expected argument')
          }
        } else if (typeof(itemLocations) === 'undefined') {
          // Otherwise it's just turning on item randomization.
          itemLocations = true
        }
        if (typeof(itemLocations) === 'object'
            && Object.getOwnPropertyNames(itemLocations).length === 0) {
          itemLocations = true
        }
        options.itemLocations = itemLocations
        break
      }
      case 'b': {
        let prologueRewards = options.prologueRewards || true
        // Check for an argument
        if (randomize[i] === ':') {
          i++
          let args = 0
          while (i < randomize.length && randomize[i] !== ',') {
            let arg
            let start
            // Parse the arg name.
            start = i
            while (i < randomize.length
                   && [',', ':'].indexOf(randomize[i]) === -1) {
              i++
            }
            arg = randomize.slice(start, i)
            if (!arg.length) {
              throw new Error('Expected argument')
            }
            const item = arg
            if (['h', 'n', 'p'].indexOf(item) === -1) {
              throw new Error('Unknown reward: ' + arg)
            }
            if (randomize[i] !== ':') {
              throw new Error('Expected argument')
            }
            start = ++i
            while (i < randomize.length
                   && [',', ':'].indexOf(randomize[i]) === -1) {
              i++
            }
            arg = randomize.slice(start, i)
            let replaceName = ''
            if (arg.length) {
              const replace = items.filter(function(item) {
                let name = item.name.replace(/[^a-zA-Z0-9]/g, '')
                name = name.toLowerCase()
                return name === arg.toLowerCase()
              })[0]
              if (!replace) {
                throw new Error('Unknown item: ' + arg)
              }
              replaceName = replace.name
            }
            if (typeof(prologueRewards) !== 'object') {
              prologueRewards = {}
            }
            prologueRewards[item] = replaceName
            if (randomize[i] === ':') {
              i++
            }
            args++
          }
          if (randomize[i] === ',') {
            i++
          }
          if (!args) {
            throw new Error('Expected argument')
          }
        } else if (typeof(prologueRewards) === 'undefined') {
          // Otherwise it's just turning on reward randomization.
          prologueRewards = true
        }
        if (typeof(prologueRewards) === 'object'
            && Object.getOwnPropertyNames(prologueRewards).length === 0) {
          prologueRewards = true
        }
        options.prologueRewards = prologueRewards
        break
      }
      case 'r': {
        let relicLocations = options.relicLocations || true
        // Check for an argument.
        if (randomize[i] === ':') {
          i++
          let args = 0
          while (i < randomize.length && randomize[i] !== ',') {
            // If there's an argument it's either a location lock, a location
            // extension, or a complexity target.
            const relicNames = Object.getOwnPropertyNames(constants.RELIC)
            let arg
            let start
            // Parse the arg name.
            start = i
            while (i < randomize.length
                   && [',', ':'].indexOf(randomize[i]) === -1) {
              i++
            }
            arg = randomize.slice(start, i)
            if (!arg.length) {
              throw new Error('Expected argument')
            }
            const locations = relics.map(function(relic) {
              return relic.ability
            }).concat(extension.map(function(location) {
              return location.name
            }))
            let ext
            let location
            let placing
            if (/^[0-9]+(-[0-9]+)?$/.test(arg)) {
              location = arg
            } else if (arg === 'x') {
              ext = true
            } else {
              if (arg.startsWith('@')) {
                placing = true
                arg = arg.slice(1)
              }
              location = locations.filter(function(name) {
                if (name.length > 1) {
                  const loc = name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
                  return loc === arg.toLowerCase()
                }
                return name === arg
              }).pop()
              if (!location) {
                throw new Error('Invalid relic location: ' + arg)
              }
            }
            if (typeof(relicLocations) !== 'object') {
              relicLocations = {}
            }
            if (randomize[i] === ':') {
              start = ++i
              while (i < randomize.length
                     && [',', ':'].indexOf(randomize[i]) === -1) {
                i++
              }
              arg = randomize.slice(start, i)
              if (ext) {
                const keys = Object.getOwnPropertyNames(constants.EXTENSION)
                const extensions = keys.map(function(key) {
                  return constants.EXTENSION[key]
                })
                if (extensions.indexOf(arg) === -1) {
                  throw new Error('Invalid relic locations extension: ' + arg)
                }
                relicLocations.extension = arg
              } else {
                const invalid = arg.split('').filter(function(c) {
                  if (c === '-' || c === '+') {
                    return false
                  }
                  return !relicNames.some(function(relic) {
                    return constants.RELIC[relic] === c
                  })
                })
                if (invalid.length) {
                  throw new Error('Invalid relic: ' + invalid[0])
                }
                const parts = arg.split('+')
                if (placing && parts.length != 1) {
                  throw new Error('Can only place 1 relic per location')
                } else if (parts.length > 2) {
                  throw new Error('Invald lock: ' + location + ':' + arg)
                }
                parts.forEach(function(part, index) {
                  let locks = part.split('-')
                  if (placing && locks.length != 1) {
                    throw new Error('Can only place 1 relic per location')
                  }
                  const emptyLocks = locks.filter(function(lock) {
                    return lock.length === 0
                  })
                  locks = locks.filter(function(lock) {
                    return lock.length > 0
                  })
                  if (emptyLocks.length > 1
                      || (locks.length && emptyLocks.length)) {
                    throw new Error('Invald lock: ' + location + ':' + arg)
                  }
                  if (index > 0) {
                    locks = locks.map(function(lock) { return '+' + lock })
                  }
                  if (placing) {
                    relicLocations.placed = relicLocations.placed || {}
                    relicLocations.placed[location] = locks[0]
                  } else {
                    relicLocations[location] = relicLocations[location] || []
                    Array.prototype.push.apply(relicLocations[location], locks)
                  }
                })
              }
            } else {
              throw new Error('Expected argument')
            }
            if (randomize[i] === ':') {
              i++
            }
            args++
          }
          if (randomize[i] === ',') {
            i++
          }
          if (!args) {
            throw new Error('Expected argument')
          }
        } else if (typeof(relicLocations) === 'undefined') {
          // Otherwise it's just turning on relic randomization.
          relicLocations = true
        }
        if (typeof(relicLocations) === 'object'
            && Object.getOwnPropertyNames(relicLocations).length === 0) {
          relicLocations = true
        }
        options.relicLocations = relicLocations
        break
      }
      case 'm': {
        options.music = true
        break
      }
      case 't': {
        options.turkeyMode = true
        break
      }
      default:
        throw new Error('Invalid randomization: ' + c)
      }
    }
    if (!Object.getOwnPropertyNames(options).length) {
      throw new Error('No randomizations')
    }
    return options
  }

  function presets() {
    try {
      if (self) {
        return self.sotnRando.presets
      } else {
        return require('./build/presets')
      }
    } catch (err) {
      return []
    }
  }

  function presetFromName(name) {
    const all = presets()
    return all.filter(function(preset) {
      return 'id' in preset && preset.id === name
    }).pop()
  }

  function optionsToString(options, disableRecurse) {
    options = Object.assign({}, options)
    delete options.checkVanilla
    delete options.verbose
    Object.getOwnPropertyNames(options).forEach(function(opt) {
      if (options[opt] === false) {
        delete options[opt]
      }
    })
    const safe = presetFromName('safe')
    // Handle the edge case where there is a preset, but the remaining
    // options are the same as the preset options.
    if ('preset' in options
        && Object.getOwnPropertyNames(options).length > 1) {
      // If relicLocations is strictly true, replace it with the safe preset
      // location locks.
      const copy = Object.assign({}, options)
      delete copy.preset
      if (copy.relicLocations === true) {
        copy.relicLocations = clone(safe.options().relicLocations)
      }
      // Now compare the remaining options to the preset options.
      const preset = presetFromName(options.preset)
      if (optionsToString(copy) === optionsToString(preset.options())) {
        // If they match, the options become the preset by itself.
        options = {preset: preset.id}
      }
    }
    let randomize = []
    while (Object.getOwnPropertyNames(options).length) {
      if ('preset' in options) {
        randomize.push('p:' + options.preset)
        delete options.preset
      } else if ('enemyDrops' in options) {
        if (options.enemyDrops) {
          let opt = 'd'
          if (typeof(options.enemyDrops) === 'object') {
            const drops = options.enemyDrops
            Object.getOwnPropertyNames(drops).forEach(function(enemyName) {
              if (enemyName === '*') {
                opt += ':*'
              } else {
                opt += ':' + enemyName.replace(/[^a-zA-Z0-9\-]/g, '')
              }
              if (drops[enemyName].length) {
                opt += ':'
                opt += drops[enemyName].map(function(dropName) {
                  if (dropName) {
                    return dropName.replace(/[^a-zA-Z0-9]/g, '')
                  }
                }).join('-')
              }
            })
          }
          randomize.push(opt)
        }
        delete options.enemyDrops
      } else if ('startingEquipment' in options) {
        if (options.startingEquipment) {
          let opt = 'e'
          const eq = options.startingEquipment
          if (typeof(eq) === 'object') {
            if ('r' in eq) {
              opt += ':r:'
              if (eq.r) {
                opt += eq.r.replace(/[^a-zA-Z0-9]/g, '')
              }
            }
            if ('l' in eq) {
              opt += ':l:'
              if (eq.r) {
                opt += eq.l.replace(/[^a-zA-Z0-9]/g, '')
              }
            }
            if ('h' in eq) {
              opt += ':h:'
              if (eq.h) {
                opt += eq.h.replace(/[^a-zA-Z0-9]/g, '')
              }
            }
            if ('b' in eq) {
              opt += ':b:'
              if (eq.b) {
                opt += eq.b.replace(/[^a-zA-Z0-9]/g, '')
              }
            }
            if ('c' in eq) {
              opt += ':c:'
              if (eq.c) {
                opt += eq.c.replace(/[^a-zA-Z0-9]/g, '')
              }
            }
            if ('o' in eq) {
              opt += ':o:'
              if (eq.o) {
                opt += eq.o.replace(/[^a-zA-Z0-9]/g, '')
              }
            }
            if ('a' in eq) {
              opt += ':a:'
              if (eq.a) {
                opt += eq.a.replace(/[^a-zA-Z0-9]/g, '')
              }
            }
            if ('x' in eq) {
              opt += ':x:'
              if (eq.x) {
                opt += eq.x.replace(/[^a-zA-Z0-9]/g, '')
              }
            }
          }
          randomize.push(opt)
        }
        delete options.startingEquipment
      } else if ('itemLocations' in options) {
        if (options.itemLocations) {
          let opt = 'i'
          if (typeof(options.itemLocations) === 'object') {
            const zoneNames = Object.getOwnPropertyNames(constants.ZONE)
            const zones = ['*'].concat(zoneNames)
            zones.forEach(function(zone) {
              if (zone in options.itemLocations) {
                const items = options.itemLocations[zone]
                Object.getOwnPropertyNames(items).forEach(function(itemName) {
                  const map = items[itemName]
                  if (itemName !== '*') {
                    itemName = itemName.replace(/[^a-zA-Z0-9]/g, '')
                  }
                  const indexes = Object.getOwnPropertyNames(map)
                  indexes.forEach(function(index) {
                    index = parseInt(index)
                    const replaceName = map[index]
                    opt += ':' + zone
                      + ':' + itemName
                      + (index > 0 ? '-' + (index + 1) : '')
                      + ':' + replaceName.replace(/[^a-zA-Z0-9]/g, '')
                  })
                })
              }
            })
          }
          randomize.push(opt)
        }
        delete options.itemLocations
      } else if ('prologueRewards' in options) {
        if (options.prologueRewards) {
          let opt = 'b'
          if (typeof(options.prologueRewards) === 'object') {
            const rewards = ['h', 'n', 'p']
            rewards.forEach(function(reward) {
              if (reward in options.prologueRewards) {
                opt += ':' + reward
                if (options.prologueRewards[reward]) {
                  const itemName = options.prologueRewards[reward]
                  opt += ':' + itemName.replace(/[^a-zA-Z0-9]/g, '')
                } else {
                  opt += ':'
                }
              }
            })
          }
          randomize.push(opt)
        }
        delete options.prologueRewards
      } else if ('relicLocations' in options) {
        if (options.relicLocations) {
          let opt = 'r'
          if (typeof(options.relicLocations) === 'object') {
            const locks = []
            const keys = Object.getOwnPropertyNames(options.relicLocations)
            for (let i = 0; i < keys.length; i++) {
              if (/^[0-9]+(-[0-9]+)?$/.test(keys[i])) {
                let lock = keys[i]
                lock += ':' + options.relicLocations[keys[i]].join('-')
                locks.push(lock)
                break
              }
            }
            if (options.relicLocations.extension) {
              locks.push('x:' + options.relicLocations.extension)
            }
            const locations = relics.concat(extension)
            const self = this
            locations.filter(function(location) {
              const extensions = []
              switch (options.relicLocations.extension) {
              case constants.EXTENSION.EQUIPMENT:
                extensions.push(constants.EXTENSION.EQUIPMENT)
              case constants.EXTENSION.GUARDED:
                extensions.push(constants.EXTENSION.GUARDED)
                break
              default:
                return !('extension' in location)
              }
              return !('extension' in location)
                || extensions.indexOf(location.extension) !== -1
            }).map(function(location) {
              if (typeof(location.ability) === 'string') {
                return location.ability
              }
              return location.name
            }).forEach(function(location) {
              if (options.relicLocations[location]) {
                let lock = location.replace(/[^a-zA-Z0-9]/g, '')
                lock += ':' + options.relicLocations[location].filter(
                  function(lock) {
                    return lock[0] !== '+'
                  }
                ).join('-')
                const escapes = options.relicLocations[location].filter(
                  function(lock) {
                    return lock[0] === '+'
                  }
                ).map(function(lock) {
                  return lock.slice(1)
                })
                if (escapes.length) {
                  lock += '+' + escapes.join('-')
                }
                locks.push(lock)
              }
            })
            if (options.relicLocations.placed) {
              let placed = options.relicLocations.placed
              Object.getOwnPropertyNames(placed).forEach(function(location) {
                locks.push('@' + location + ':' + placed[location])
              })
            }
            if (locks.length) {
              opt += ':' + locks.join(':')
            }
          }
          randomize.push(opt)
        }
        delete options.relicLocations
      } else if ('music' in options) {
        if (options.music) {
          randomize.push('m')
        }
        delete options.music
      } else if ('turkeyMode' in options) {
        if (options.turkeyMode) {
          randomize.push('t')
        }
        delete options.turkeyMode
      } else {
        const unknown = Object.getOwnPropertyNames(options).pop()
        throw new Error('Unknown options: ' + unknown)
      }
    }
    if (!randomize.length) {
      throw new Error('No randomizations')
    }
    randomize = randomize.reduce(function(str, opt, index) {
      if (opt.length > 1 && index < randomize.length - 1) {
        opt += ','
      }
      return str + opt
    }, '')
    // Handle the edge case where the options are the same as a preset.
    if (!disableRecurse) {
      const preset = presets().filter(function(preset) {
        if (preset instanceof Preset) {
          const options = preset.options()
          if (preset === safe) {
            options.relicLocations = true
          }
          return optionsToString(options, true) === randomize
        }
      }).pop()
      if (preset) {
        randomize = 'p:' + preset.id
      }
    }
    return randomize
  }

  function optionsToUrl(version, options, checksum, seed, baseUrl) {
    options = optionsToString(options)
    const args = []
    const releaseBaseUrl = constants.optionsUrls[constants.defaultOptions]
    if (version.match(/-/)) {
      baseUrl = constants.devBaseUrl
      if (options !== constants.defaultOptions) {
        args.push(options)
      }
    } else if (!baseUrl || baseUrl === releaseBaseUrl) {
      if (options in constants.optionsUrls) {
        baseUrl = constants.optionsUrls[options]
      } else {
        baseUrl = releaseBaseUrl
        args.push(options)
      }
    }
    if (typeof(checksum) === 'number') {
      args.push(checksum.toString(16))
    } else if (checksum !== undefined) {
      args.push(checksum)
    }
    if (seed !== undefined) {
      args.push(encodeURIComponent(seed))
    }
    let url = baseUrl
    if (args.reduce(function(prev, next) {
      if (next !== '') {
        return true
      }
      return prev
    }, false)) {
      url += '?' + args.join(',')
    }
    return url
  }

  function optionsFromUrl(url) {
    url = new URL(url)
    const args = url.search.slice(1).split(',')
    const baseUrl = url.origin + url.pathname
    const presets = Object.getOwnPropertyNames(constants.optionsUrls)
    for (let i = 0; i < presets.length; i++) {
      if (constants.optionsUrls[presets[i]] === baseUrl) {
        if (args.length === 1) {
          args.unshift(undefined)
        }
        args.unshift(presets[i])
        break
      }
    }
    let options
    let checksum
    let seed
    if (args.length > 2) {
      options = optionsFromString(args.slice(0, args.length - 2).join(','))
    } else {
      options = optionsFromString(constants.defaultOptions)
    }
    seed = decodeURIComponent(args.pop())
    checksum = parseInt(args.pop(), 16)
    return {
      options: options,
      checksum: checksum,
      seed: seed,
    }
  }

  const map = {
    ',': 0x8143,
    '.': 0x8144,
    ':': 0x8146,
    ';': 0x8147,
    '?': 0x8148,
    '!': 0x8149,
    '`': 0x814d,
    '"': 0x814e,
    '^': 0x814f,
    '_': 0x8151,
    '~': 0x8160,
    '\'': 0x8166,
    '(': 0x8169,
    ')': 0x816a,
    '[': 0x816d,
    ']': 0x816e,
    '{': 0x816f,
    '}': 0x8170,
    '+': 0x817b,
    '-': 0x817c,
    '0': 0x824f,
    '1': 0x8250,
    '2': 0x8251,
    '3': 0x8252,
    '4': 0x8253,
    '5': 0x8254,
    '6': 0x8255,
    '7': 0x8256,
    '8': 0x8257,
    '9': 0x8258,
  }

  function writeMenuText(data, text, range) {
    let a = 0
    let s = 0
    while (a < range.length && s < text.length) {
      if (text[s] in map) {
        if ((a + 1) < range.length) {
          const val = map[text[s++]]
          data.writeChar(range.start + a++, val >>> 8)
          data.writeChar(range.start + a++, val & 0xff)
        } else {
          break
        }
      } else if (text[s].match(/[a-zA-Z ]/)) {
        data.writeChar(range.start + a++, text.charCodeAt(s++))
      } else {
        s++
      }
    }
  }

  function setSeedText(data, seed, preset) {
    const seedRange = {
      start: 0x04389c6c,
      length: 31,
    }
    const presetRange = {
      start: 0x04389c8c,
      length: 20,
    }
    for (let i = 0; i < 52; i++) {
      data.writeChar(0x04389c6c + i, 0)
    }
    data.writeShort(0x043930c4, 0x78b4)
    data.writeShort(0x043930d4, 0x78d4)
    data.writeShort(0x0439312c, 0x78b4)
    data.writeShort(0x0439313c, 0x78d4)
    writeMenuText(data, seed, seedRange)
    writeMenuText(data, preset || '', presetRange)
  }

  function saltSeed(version, options, seed, nonce) {
    nonce = nonce || 0
    return JSON.stringify({
      version: version,
      options: optionsToString(options),
      seed: seed,
      nonce: nonce,
    })
  }

  function restoreFile(data, file) {
    const dataLength = file.len + Math.floor(file.len / 0x800) * 0x130
    data = data.slice(file.pos, file.pos + dataLength)
    file = Buffer.alloc(file.len)
    let curr = file
    while (data.length) {
      curr.set(data.slice(0, 0x800))
      curr = curr.slice(0x800)
      data = data.slice(0x800 + 0x130)
    }
    return file
  }

  function formatObject(obj, indent, hex) {
    indent = indent || 0
    if (Array.isArray(obj)) {
      let padFirst
      let padLast
      if (obj.length > 0) {
        padFirst = typeof(obj[0]) !== 'object'
        padLast = typeof(obj[obj.length - 1]) !== 'object'
      }
      return '[' + (padFirst ? ' ' : '') + obj.map(function(el) {
        return formatObject(el, indent, hex)
      }).join(', ') + (padLast ? ' ' : '') + ']'
    }
    switch (typeof(obj)) {
    case 'string':
      return '\'' + entry[1].replace(/'/, '\\\'') + '\''
    case 'number':
      if (hex) {
        return numToHex(obj)
      }
      return obj.toString(10)
    case 'object':
      const outer = Array(indent).fill(' ').join('')
      const inner = Array(indent + 2).fill(' ').join('')
      const lines = []
      for (entry of Object.entries(obj)) {
        let name = inner + entry[0] + ': '
        let value
        switch (entry[0]) {
        case 'ability':
          const names = Object.getOwnPropertyNames(constants.RELIC)
          value = 'RELIC.' + names.filter(function(name) {
            return constants.RELIC[name] === entry[1]
          })[0]
          break
        case 'enemy':
          if (entry[1] === constants.GLOBAL_DROP) {
            value = 'GLOBAL_DROP'
          } else {
            value = entry[1]
          }
          break
        case 'type':
          value = 'TYPE.' + constants.typeNames[entry[1]]
          break
        case 'zones':
          value = '[ ' + entry[1].map(function(zoneId) {
            return 'ZONE.' + constants.zoneNames[zoneId]
          }).join(', ') + ' ]'
          break
        case 'candle':
          value = numToHex(entry[1], 2)
          break
        default:
          let hex
          const hexTypes = [
            'addresses',
            'blacklist',
            'entities',
            'dropAddresses',
          ]
          if (hexTypes.indexOf(entry[0]) !== -1) {
            hex = true
          }
          value = formatObject(entry[1], indent + 2, hex)
          break
        }
        lines.push(name + value + ',')
      }
      return '{\n' + lines.join('\n') + '\n' + outer + '}'
    }
    return obj.toString()
  }

  function formatInfo(info, verbosity) {
    if (!info) {
      return ''
    }
    const props = []
    for (let level = 0; level <= verbosity; level++) {
      Object.getOwnPropertyNames(info[level]).forEach(function(prop) {
        if (props.indexOf(prop) === -1) {
          props.push(prop)
        }
      })
    }
    const lines = []
    props.forEach(function(prop) {
      for (let level = 0; level <= verbosity; level++) {
        if (info[level][prop]) {
          let text = prop + ':'
          if (Array.isArray(info[level][prop])) {
            text += '\n' + info[level][prop].map(function(item) {
              return '  ' + item
            }).join('\n')
          } else {
            text += ' ' + info[level][prop]
          }
          lines.push(text)
        }
      }
    })
    return lines.join('\n')
  }

  function newInfo() {
    const MAX_VERBOSITY = 5
    return Array(MAX_VERBOSITY + 1).fill(null).map(function() {
      return {}
    })
  }

  function mergeInfo(info, newInfo) {
    if (newInfo) {
      info.forEach(function(level, index) {
        merge.call(level, newInfo[index])
      })
    }
  }

  function sanitizeResult(result) {
    if (result.mapping) {
      Object.getOwnPropertyNames(result.mapping).forEach(function(location) {
        const relic = result.mapping[location]
        result.mapping[location] = Object.assign({}, relic, {
          replaceWithItem: undefined,
          replaceWithRelic: undefined,
        })
      })
    }
    if (result.relics) {
      result.relics = result.relics.map(function(relic) {
        return Object.assign({}, relic, {
          replaceWithItem: undefined,
          replaceWithRelic: undefined,
        })
      })
    }
    if (result.locations) {
      result.locations = result.locations.map(function(location) {
        return Object.assign({}, location, {
          replaceWithItem: undefined,
          replaceWithRelic: undefined,
        })
      })
    }
  }

  function shuffled(rng, array) {
    const copy = array.slice()
    const shuffled = []
    while (copy.length) {
      const rand = Math.floor(rng() * copy.length)
      shuffled.push(copy.splice(rand, 1)[0])
    }
    return shuffled
  }

  function isRelic(entity) {
    return entity.data.readUInt16LE(4) === 0x000b
  }

  function isItem(entity) {
    return entity.data.readUInt16LE(4) === 0x000c
  }

  function isCandle(zone, entity) {
    const states = []
    switch (zone.id) {
    case constants.ZONE.ST0:
      states.push(0x20, 0x30, 0x80, 0x90)
      break
    case constants.ZONE.ARE:
      states.push(0x10)
      break
    case constants.ZONE.CAT:
      states.push(0x00, 0x10, 0x20)
      break
    case constants.ZONE.CHI:
      states.push(0x00, 0x10)
      break
    case constants.ZONE.DAI:
      states.push(0x00, 0x10)
      break
    case constants.ZONE.LIB:
      states.push(0x00)
      break
    case constants.ZONE.NO0:
      states.push(0x00, 0x10, 0x20, 0x80)
      break
    case constants.ZONE.NO1:
      states.push(0x50, 0x60)
      break
    case constants.ZONE.NO2:
      states.push(0x00, 0x10, 0x20, 0x30, 0x40, 0x60)
      break
    case constants.ZONE.NO3:
    case constants.ZONE.NP3:
      states.push(0x00)
      break
    case constants.ZONE.NO4:
      states.push(0x00, 0x50, 0x60)
      break
    case constants.ZONE.NZ0:
      states.push(0x00, 0x10, 0x20)
      break
    case constants.ZONE.NZ1:
      states.push(0x00, 0x10, 0x40, 0x50, 0x60)
      break
    case constants.ZONE.TOP:
      states.push(0x20, 0x30, 0x60)
      break
    case constants.ZONE.RARE:
      states.push(0x10)
      break
    case constants.ZONE.RCAT:
      states.push(0x00, 0x10, 0x20)
      break
    case constants.ZONE.RCHI:
      states.push(0x00, 0x10)
      break
    case constants.ZONE.RDAI:
      states.push(0x00, 0x10)
      break
    case constants.ZONE.RLIB:
      states.push(0x00)
      break
    case constants.ZONE.RNO0:
      states.push(0x00, 0x10, 0x20, 0x80)
      break
    case constants.ZONE.RNO1:
      states.push(0x50, 0x60)
      break
    case constants.ZONE.RNO2:
      states.push(0x00, 0x10, 0x20, 0x30, 0x40, 0x60)
      break
    case constants.ZONE.RNO3:
      states.push(0x00)
      break
    case constants.ZONE.RNO4:
      states.push(0x00, 0x50, 0x60)
      break
    case constants.ZONE.RNZ0:
      states.push(0x00, 0x10, 0x20)
      break
    case constants.ZONE.RNZ1:
      states.push(0x10, 0x40, 0x50, 0x60)
      break
    case constants.ZONE.RTOP:
      states.push(0x20, 0x30, 0x60)
      break
    }
    const id = entity.data.readUInt16LE(4)
    return id === 0xa001 && states.indexOf(entity.data[9] & 0xf0) !== -1
  }

  function isContainer(zone, entity) {
    const id = entity.data.readUInt16LE(4)
    const ids = []
    switch (zone.id) {
    case constants.ZONE.CAT:
      if (id == 0x002c) {
        return entity.data[8] > 0
      }
      ids.push({
        id: 0x0025,
      })
      ids.push({
        id: 0xa001,
        states: [ 0x70 ],
      })
      break
    case constants.ZONE.CHI:
      ids.push({
        id: 0x0018,
      })
      break
    case constants.ZONE.RCHI:
      ids.push({
        id: 0x0020,
      })
      break
    case constants.ZONE.DAI:
    case constants.ZONE.RDAI:
    case constants.ZONE.RNO4:
      ids.push({
        id: 0xa001,
        states: [ 0x70, 0x80 ],
      })
      break
    case constants.ZONE.RLIB:
      ids.push({
        id: 0x0029,
      })
      ids.push({
        id: 0xa001,
        states: [ 0x70, 0x90 ],
      })
      break
    case constants.ZONE.LIB:
      if (id == 0x003d) {
        return entity.data[9] === 0
      }
      ids.push({
        id: 0xa001,
        states: [ 0x70, 0x90 ],
      })
      break
    case constants.ZONE.NO1:
      ids.push({
        id: 0xa001,
        states: [ 0x70, 0x80 ],
      })
      break
    case constants.ZONE.RNO1:
      ids.push({
        id: 0xa001,
        states: [ 0x70, 0x80 ],
      })
      break
    case constants.ZONE.NO2:
    case constants.ZONE.RNO2:
      ids.push({
        id: 0xa001,
        states: [ 0x70 ],
      })
      break
    case constants.ZONE.NO4:
    case constants.ZONE.BO3:
      ids.push({
        id: 0xa001,
        states: [ 0x70 ],
      })
      break
    case constants.ZONE.NZ0:
      ids.push({
        id: 0x0034,
      }, {
        id: 0x0035,
      }, {
        id: 0x0036,
      }, {
        id: 0x0037,
      })
      break
    case constants.ZONE.TOP:
    case constants.ZONE.RTOP:
      ids.push({
        id: 0xa001,
        states: [ 0x70, 0x80, 0x90 ],
      })
      ids.push({
        id: 0x001b,
      })
      break
    case constants.ZONE.RCAT:
      ids.push({
        id: 0xa001,
        states: [ 0x70 ],
      })
      ids.push({
        id: 0x002e,
      })
      break
    case constants.ZONE.RNO3:
      ids.push({
        id: 0x0045,
      })
      break
    case constants.ZONE.RNZ0:
      ids.push({
        id: 0x0027,
      })
      ids.push({
        id: 0x0028,
      })
      ids.push({
        id: 0x0029,
      })
      ids.push({
        id: 0x002a,
      })
      ids.push({
        id: 0x002b,
      })
      break
    }
    for (let i = 0; i < ids.length; i++) {
      if (ids[i].id === id) {
        if ('states' in ids[i]
            && ids[i].states.indexOf(entity.data[9]) === -1) {
          return false
        }
        return true
      }
    }
  }

  function containedItem(data, zone, entity) {
    let index
    const entId = entity.data.readUInt16LE(4)
    const state = entity.data.readUInt16LE(8)
    switch (zone.id) {
    case constants.ZONE.RCHI:
    case constants.ZONE.CHI: {
      index = state + 3
      break
    }
    case constants.ZONE.NZ0: {
      switch (entId) {
      case 0x0034:
        switch (state) {
        case 0x0003:
          index = 6
          break
        case 0x0004:
          index = 10
          break
        default:
          index = state
          break
        }
        break
      case 0x0035:
        index = state + 3
        break
      case 0x0036:
        index = state + 7
        break
      case 0x0037:
        switch (state) {
        case 0x002:
          return {
            index: state,
            item: relicFromName('Bat Card')
          }
        case 0x0003:
          return {
            index: state,
            item: relicFromName('Skill of Wolf')
          }
        }
      }
      break
    }
    case constants.ZONE.TOP:
      if (entId === 0x001b) {
        index = 2 - state
        break
      }
    case constants.ZONE.LIB:
      if (entId === 0x003d) {
        index = state + 1
        break
      }
    case constants.ZONE.RLIB:
      if (entId === 0x0029) {
        index = state + 6
        break
      }
    case constants.ZONE.CAT: {
      if (entId === 0x0025) {
        index = 4 * state 
        break
      }
    }
    case constants.ZONE.RCAT: {
      if (entId === 0x002e) {
        index = 7 * state + 1
        break
      }
    }
    case constants.ZONE.NO1:
      if ((state >> 8) === 0x80) {
        index = 3 + (state & 0xff)
        break
      }
    case constants.ZONE.DAI:
    case constants.ZONE.LIB:
    case constants.ZONE.NO2:
    case constants.ZONE.NO4:
    case constants.ZONE.BO3:
    case constants.ZONE.RDAI:
    case constants.ZONE.RNO1:
    case constants.ZONE.RNO2:
    case constants.ZONE.RNO4:
    case constants.ZONE.RTOP:
      index = entity.data[8]
      break
    default:
      index = entity.data.readUInt16LE(8)
      break
    }
    const id = data.readUInt16LE(zone.items + 0x2 * index)
    const item = itemFromTileId(items, id)
    return {
      index: index,
      item: item,
    }
  }

  function relicFromAbility(ability) {
    return relics.filter(function(relic) {
      return relic.ability === ability
    }).pop()
  }

  function relicFromName(name) {
    return relics.filter(function(relic) {
      return relic.name === name
    }).pop()
  }

  function enemyFromIdString(idString) {
    const dashIndex = idString.lastIndexOf('-')
    let enemyName = idString.toLowerCase()
    let level
    if (dashIndex !== -1) {
      level = parseInt(enemyName.slice(dashIndex + 1))
      enemyName = idString.slice(0, dashIndex).toLowerCase()
    }
    return enemies.filter(function(enemy) {
      const name = enemy.name.toLowerCase().replace(/[^a-zA-Z0-9]/g, '')
      if (name === enemyName) {
        if (typeof(level) !== 'undefined') {
          return enemy.level === level
        }
        return true
      }
    }).pop()
  }

  function Preset(
    id,
    name,
    description,
    author,
    weight,
    enemyDrops,
    startingEquipment,
    itemLocations,
    prologueRewards,
    relicLocations,
    music,
    turkeyMode,
  ) {
    this.id = id
    this.name = name
    this.description = description
    this.author = author
    this.weight = weight
    this.enemyDrops = enemyDrops
    this.startingEquipment = startingEquipment
    this.itemLocations = itemLocations
    this.prologueRewards = prologueRewards
    this.relicLocations = relicLocations
    this.music = music
    this.turkeyMode = turkeyMode
  }

  function clone(obj) {
    if (Array.isArray(obj)) {
      return obj.slice().map(clone)
    } else if (typeof(obj) === 'object') {
      return Object.getOwnPropertyNames(obj).reduce(function(copy, prop) {
        copy[prop] = clone(obj[prop])
        return copy
      }, {})
    }
    return obj
  }

  function merge(obj) {
    const self = this
    Object.getOwnPropertyNames(obj).forEach(function(prop) {
      if (Array.isArray(obj[prop])) {
        self[prop] = clone(obj[prop])
      } else if (typeof(obj[prop]) === 'object') {
        if (Array.isArray(self[prop])) {
          self[prop] = clone(obj[prop])
        } else if (typeof(self[prop]) === 'object') {
          merge(self[prop], obj[prop])
        } else {
          self[prop] = clone(obj[prop])
        }
      } else {
        self[prop] = clone(obj[prop])
      }
    })
  }

  Preset.options = function options(options) {
    options = clone(options)
    if (options.preset) {
      let preset = presets().filter(function(preset) {
        return preset.id === options.preset
      }).pop()
      if (!preset && !self) {
        try {
          preset = require('./build/presets/' + options.preset)
        } catch (err) {
          if (err.code !== 'MODULE_NOT_FOUND') {
            console.error(err.stack)
            throw new Error('Error loading preset: ' + options.preset)
          }
        }
      }
      if (!preset) {
        throw new Error('Unknown preset: ' + options.preset)
      }
      delete options.preset
      const presetOptions = preset.options()
      merge.call(presetOptions, options)
      return presetOptions
    }
    return options
  }

  Preset.prototype.toString = function toString() {
    return optionsToString.bind(this, this.options())()
  }

  Preset.prototype.options = function options() {
    const options = Object.assign({}, this)
    delete options.id
    delete options.name
    delete options.description
    delete options.author
    delete options.weight
    return clone(options)
  }

  // Helper class to create relic location locks.
  function PresetBuilder(metadata) {
    this.metadata = metadata
    // The collection of enemy drops.
    this.drops = true
    // The collection of starting equipment.
    this.equipment = true
    // The collection of item locations.
    this.items = true
    // The collection of prologue rewards.
    this.rewards = true
    // The collection of location locks.
    this.locations = true
    // The collection of escape requirements.
    this.escapes = {}
    // The relic locations extension.
    this.extension = constants.EXTENSION.GUARDED
    // The complexity goal.
    this.goal = undefined
    // Music randomization.
    this.music = true
    // Turkey mode.
    this.turkey = true
  }

  function locationFromName(name) {
    const relic = relicFromName(name)
    if (relic) {
      return relic.ability
    }
    return name
  }

  function locksFromArray(locks) {
    return locks.map(function(lock) {
      return lock.split(/\s*\+\s*/).map(function(name) {
        return relicFromName(name).ability
      }).join('')
    })
  }

  PresetBuilder.fromJSON = function fromJSON(json) {
    const builder = new PresetBuilder(json.metadata)
    if ('inherits' in json) {
      builder.inherits(json.inherits)
    }
    if ('itemLocations' in json) {
      if (typeof(json.itemLocations) === 'boolean') {
        builder.itemLocations(json.itemLocations)
      } else if (Array.isArray(json.itemLocations)) {
        json.itemLocations.forEach(function(itemLocation) {
          let zone
          if (itemLocation.zone === '*') {
            zone = '*'
          } else {
            zone = constants.ZONE[itemLocation.zone]
          }
          const args = [zone, itemLocation.item]
          if ('index' in itemLocation) {
            args.push(itemLocation.index)
          }
          args.push(itemLocation.replacement)
          builder.itemLocations.apply(builder, args)
        })
      } else {
        throw new Error('unsupported itemLocations type')
      }
    }
    if ('enemyDrops' in json) {
      if (typeof(json.enemyDrops) === 'boolean') {
        builder.enemyDrops(json.enemyDrops)
      } else if (Array.isArray(json.enemyDrops)) {
        json.enemyDrops.forEach(function(enemyDrop) {
          const args = [enemyDrop.enemy]
          if ('level' in enemyDrop) {
            args.push(enemyDrop.level)
          }
          Array.prototype.push.apply(args, enemyDrop.items)
          builder.enemyDrops.apply(builder, args)
        })
      } else {
        throw new Error('unsupported enemyDrops type')
      }
    }
    if ('prologueRewards' in json) {
      if (typeof(json.prologueRewards) === 'boolean') {
        builder.prologueRewards(json.prologueRewards)
      } else if (Array.isArray(json.prologueRewards)) {
        json.prologueRewards.forEach(function(prologueReward) {
          builder.prologueRewards(
            prologueReward.item,
            prologueReward.replacement,
          )
        })
      } else {
        throw new Error('unsupported prologueRewards type')
      }
    }
    if ('startingEquipment' in json) {
      if (typeof(json.startingEquipment) === 'boolean') {
        builder.startingEquipment(json.startingEquipment)
      } else if (Array.isArray(json.startingEquipment)) {
        json.startingEquipment.forEach(function(startingEquipment) {
          const key = startingEquipment.slot.toUpperCase().replace(' ', '_')
          builder.startingEquipment(
            constants.SLOT[key],
            startingEquipment.item,
          )
        })
      } else {
        throw new Error('unsupported startingEquipment type')
      }
    }
    if ('relicLocations' in json) {
      builder.relicLocations(json.relicLocations)
    }
    if ('relicLocationsExtension' in json) {
      builder.relicLocationsExtension(json.relicLocationsExtension)
    }
    if ('lockLocation' in json) {
      json.lockLocation.forEach(function(lockLocation) {
        const location = locationFromName(lockLocation.location)
        const locks = locksFromArray(lockLocation.locks)
        builder.lockLocation(location, locks)
        if ('escapeRequires' in lockLocation) {
          const escapes = locksFromArray(lockLocation.escapeRequires)
          builder.escapeRequires(location, escapes)
        }
      })
    }
    if ('placeRelic' in json) {
      json.placeRelic.forEach(function(placeRelic) {
        builder.placeRelic(
          locationFromName(placeRelic.location),
          relicFromName(placeRelic.relic).ability,
        )
      })
    }
    if ('complexityGoal' in json) {
      const args = [json.complexityGoal.min]
      if ('max' in json.complexityGoal) {
        args.push(json.complexityGoal.max)
      }
      args.push(locksFromArray(json.complexityGoal.goals))
      builder.complexityGoal.apply(builder, args)
    }
    return builder
  }

  PresetBuilder.prototype.inherits = function inherits(id) {
    let preset
    if (self) {
      const presets = self.sotnRando.presets
      preset = presets.filter(function(preset) {
        return preset.id === id
      }).pop()
    } else {
      preset = require('./build/presets/' + id)
    }
    if ('enemyDrops' in preset) {
      if (typeof(preset.enemyDrops) === 'object') {
        const self = this
        self.drops = new Map()
        const ids = Object.getOwnPropertyNames(preset.enemyDrops)
        ids.forEach(function(id) {
          let enemy
          if (id === '*') {
            enemy = '*'
          } else if (id === constants.GLOBAL_DROP) {
            enemy = id
          } else {
            enemy = enemyFromIdString(id)
          }
          const dropNames = preset.enemyDrops[id]
          const drops = dropNames.map(function(name) {
            return items.filter(function(item) {
              return item.name === name
            }).pop()
          })
          self.drops.set(enemy, drops)
        })
      } else {
        this.drops = preset.enemyDrops
      }
    }
    if ('startingEquipment' in preset) {
      if (typeof(preset.startingEquipment) === 'object') {
        const self = this
        self.equipment = {}
        const slots = Object.getOwnPropertyNames(preset.startingEquipment)
        slots.forEach(function(slot) {
          self.equipment[slot] = items.filter(function(item) {
            return item.name === preset.startingEquipment[slot]
          }).pop()
        })
      } else {
        this.equipment = preset.startingEquipment
      }
    }
    if ('itemLocations' in preset) {
      if (typeof(preset.itemLocations) === 'object') {
        const self = this
        self.items = {}
        const zoneNames = Object.getOwnPropertyNames(preset.itemLocations)
        zoneNames.forEach(function(zoneName) {
          self.items[zoneName] = self.items[zoneName] || new Map()
          const zoneItems = preset.itemLocations[zoneName]
          const itemNames = Object.getOwnPropertyNames(zoneItems)
          itemNames.forEach(function(itemName) {
            let item
            if (itemName === '*') {
              item = '*'
            } else {
              item = items.filter(function(item) {
                return item.name === itemName
              }).pop()
            }
            const indexes = Object.getOwnPropertyNames(zoneItems[itemName])
            indexes.forEach(function(index) {
              const replace = items.filter(function(item) {
                return item.name === zoneItems[itemName][index]
              }).pop()
              const map = self.items[zoneName].get(item) || {}
              map[index] = replace
              self.items[zoneName].set(item, map)
            })
          })
        })
      } else {
        this.items = preset.itemLocations
      }
    }
    if ('prologueRewards' in preset) {
      if (typeof(preset.prologueRewards) === 'object') {
        const self = this
        self.rewards = {}
        const rewards = Object.getOwnPropertyNames(preset.prologueRewards)
        rewards.forEach(function(reward) {
          self.rewards[reward] = items.filter(function(item) {
            return item.name === preset.prologueRewards[reward]
          }).pop()
        })
      } else {
        this.rewards = preset.prologueRewards
      }
    }
    if ('relicLocations' in preset) {
      if (typeof(preset.relicLocations) === 'object') {
        const self = this
        self.locations = {}
        if ('extension' in preset.relicLocations) {
          self.extension = preset.relicLocations.extension
        }
        const locations = Object.getOwnPropertyNames(preset.relicLocations)
        locations.filter(function(location) {
          return location !== 'extension'
        }).forEach(function(location) {
          if ((/^[0-9]+(-[0-9]+)?$/).test(location)) {
            self.goal = preset.relicLocations[location].map(function(lock) {
              return new Set(lock)
            })
            const parts = location.split('-')
            self.target = {
              min: parseInt(parts[0]),
            }
            if (parts.length === 2) {
              self.target.max = parseInt(parts[1])
            }
          } else if (location === 'placed') {
            self.locations.placed = self.locations[location]
          } else {
            // Break the lock into access locks and escape requirements.
            const locks = self.locations[location] || []
            const escape = self.escapes[location] || []
            preset.relicLocations[location].forEach(function(lock) {
              if (lock[0] === '+') {
                escape.push(new Set(lock.slice(1)))
              } else {
                locks.push(new Set(lock))
              }
            })
            self.locations[location] = locks
            self.escapes[location] = escape
          }
        })
      } else {
        this.locations = preset.relicLocations
      }
    }
    if ('music' in preset) {
      this.music = preset.music
    }
    if ('turkeyMode' in preset) {
      this.turkey = preset.turkeyMode
    }
  }

  PresetBuilder.prototype.enemyDrops =
    function enemyDrops(enemyName, level, commonDropName, rareDropName) {
      if (typeof(enemy) === 'boolean') {
        this.drops = enemy
      } else {
        const args = Array.prototype.slice.call(arguments)
        if (typeof(this.drops) !== 'object') {
          this.drops = new Map()
        }
        let enemy
        if (enemyName === constants.GLOBAL_DROP) {
          enemy = enemyName
        } else {
          if (typeof(level) !== 'number') {
            rareDropName = commonDropName
            commonDropName = level
            level = undefined
          } else {
            args.splice(1, 1)
          }
          if (enemyName === '*') {
            enemy = '*'
          } else {
            enemy = enemies.filter(function(enemy) {
              if (enemy.name === enemyName) {
                if (typeof(level) !== 'undefined') {
                  return enemy.level === level
                }
                return true
              }
            }).pop()
            assert(enemy, 'Unknown enemy: ' + enemyName)
          }
        }
        dropNames = args.slice(1)
        const drops = dropNames.map(function(dropName) {
          if (dropName) {
            const item = items.filter(function(item) {
              return item.name === dropName
            }).pop()
            assert(item, 'Unknown item: ' + dropName)
            return item
          }
        })
        this.drops.set(enemy, drops)
      }
    }

  PresetBuilder.prototype.startingEquipment =
    function startingEquipment(slot, itemName) {
      assert.oneOf(slot, [
        true,
        false,
        constants.SLOT.RIGHT_HAND,
        constants.SLOT.LEFT_HAND,
        constants.SLOT.HEAD,
        constants.SLOT.BODY,
        constants.SLOT.CLOAK,
        constants.SLOT.OTHER,
        constants.SLOT.AXEARMOR,
        constants.SLOT.LUCK_MODE,
      ])
      if (typeof(slot) === 'boolean') {
        this.equipment = slot
      } else {
        if (typeof(this.equipment) !== 'object') {
          this.equipment = {}
        }
        let item
        if (itemName) {
          item = items.filter(function(item) {
            return item.name === itemName
          }).pop()
          assert(item, 'Unknown item: ' + itemName)
          switch (slot) {
          case constants.SLOT.RIGHT_HAND:
            assert.oneOf(item.type, [
              constants.TYPE.WEAPON1,
              constants.TYPE.WEAPON2,
              constants.TYPE.SHIELD,
              constants.TYPE.USABLE,
            ])
            if (this.equipment[constants.SLOT.LEFT_HAND]) {
              assert.notEqual(
                this.equipment[constants.SLOT.LEFT_HAND].type,
                constants.TYPE.WEAPON2,
                'Cannot equipment '
                  + this.equipment[constants.SLOT.LEFT_HAND].name
                  + ' and ' + item.name
              )
            }
            break
          case constants.SLOT.LEFT_HAND:
            assert.oneOf(item.type, [
              constants.TYPE.WEAPON1,
              constants.TYPE.SHIELD,
              constants.TYPE.USABLE,
            ])
            if (this.equipment[constants.SLOT.RIGHT_HAND]) {
              assert.notEqual(
                this.equipment[constants.SLOT.RIGHT_HAND].type,
                constants.TYPE.WEAPON2,
                'Cannot equipment '
                  + this.equipment[constants.SLOT.RIGHT_HAND].name
                  + ' and ' + item.name
              )
            }
            break
          case constants.SLOT.HEAD:
            assert.equal(item.type, constants.TYPE.HELMET,
                        'Cannot equip ' + item.name + ' on head')
            break
          case constants.SLOT.BODY:
            assert.equal(item.type, constants.TYPE.ARMOR,
                        'Cannot equip ' + item.name + ' on body')
            break
          case constants.SLOT.CLOAK:
            assert.equal(item.type, constants.TYPE.CLOAK,
                        'Cannot equip ' + item.name + ' as cloak')
            break
          case constants.SLOT.OTHER:
            assert.equal(item.type, constants.TYPE.ACCESSORY,
                        'Cannot equip ' + item.name + ' as other')
            break
          case constants.SLOT.AXEARMOR:
            assert.equal(item.type, constants.TYPE.ARMOR,
                        'Cannot equip ' + item.name + ' as armor')
            break
          case constants.SLOT.LUCK_MODE:
            assert.equal(item.type, constants.TYPE.ACCESSORY,
                        'Cannot equip ' + item.name + ' as other')
            break
          }
        }
        this.equipment[slot] = item
      }
    }

  PresetBuilder.prototype.itemLocations =
    function itemLocations(zoneId, itemName, number, replaceName) {
      if (typeof(zoneId) === 'boolean') {
        this.items = zoneId
      } else {
        if (typeof(number) === 'string') {
          replaceName = number
          number = 1
        }
        assert(typeof(number) === 'number', 'Unknown item number: ' + number)
        const index = number - 1
        const zones = ['*'].concat(constants.zoneNames.map(function(zoneName) {
          return constants.ZONE[zoneName]
        }))
        assert.oneOf(zoneId, zones, 'Unknown zone: ' + zoneId)
        let zoneName
        if (zoneId === '*') {
          zoneName = '*'
        } else {
          zoneName = constants.zoneNames[zoneId]
        }
        let item
        if (itemName === '*') {
          item = '*'
        } else {
          item = items.filter(function(item) {
            return item.name === itemName
          })[0]
          assert(item, 'Unknown item: ' + itemName)
          const tiles = (item.tiles || []).filter(function(tile) {
            return 'zones' in tile && tile.zones.indexOf(zoneId) !== -1
          })
          assert(tiles[index], 'Unknown item tile: ' + itemName + ' ' + number)
        }
        const replace = items.filter(function(item) {
          return item.name === replaceName
        })[0]
        assert(replace, 'Unknown item: ' + replaceName)
        if (typeof(this.items) !== 'object') {
          this.items = {}
        }
        this.items[zoneName] = this.items[zoneName] || new Map()
        const map = this.items[zoneName].get(item) || {}
        map[number - 1] = replace
        this.items[zoneName].set(item, map)
      }
    }

  PresetBuilder.prototype.prologueRewards =
    function prologueRewards(itemName, replaceName) {
      if (typeof(itemName) === 'boolean') {
        this.rewards = itemName
      } else {
        const map = {
          'Heart Refresh': 'h',
          'Neutron Bomb': 'n',
          'Potion': 'p',
        }
        assert.oneOf(itemName, Object.getOwnPropertyNames(map),
                    'Unknown reward item: ' + itemName)
        const replace = items.filter(function(item) {
          return item.name === replaceName
        })[0]
        if (typeof(this.rewards) !== 'object') {
          this.rewards = {}
        }
        this.rewards[map[itemName]] = replace
      }
    }

  // Lock relic location behind abilities.
  PresetBuilder.prototype.lockLocation = function lockLocation(where, what) {
    if (typeof(this.locations) !== 'object') {
      this.locations = {}
    }
    this.locations[where] = this.locations[where] || []
    Array.prototype.push.apply(this.locations[where], what.map(function(lock) {
      return new Set(lock)
    }))
  }

  // Ensure that a location grants abilities, or that access to that location
  // is only granted by obtaining abilities.
  PresetBuilder.prototype.escapeRequires =
    function escapeRequires(where, what) {
      if (typeof(this.locations) !== 'object') {
        this.locations = {}
      }
      this.escapes[where] = this.escapes[where] || []
      Array.prototype.push.apply(this.escapes[where], what.map(function(lock) {
        return new Set(lock)
      }))
    }

  // Place a relic at a location.
  PresetBuilder.prototype.placeRelic = function placeRelic(where, what) {
    assert.equal(typeof(where), 'string')
    assert.equal(typeof(what), 'string')
    if (typeof(this.locations) !== 'object') {
      this.locations = {}
    }
    this.locations.placed = this.locations.placed || {}
    this.locations.placed[where] = what
  }

  // Enable/disable relic location randomization.
  PresetBuilder.prototype.relicLocations = function relicLocations(enabled) {
    assert.equal(typeof(enabled), 'boolean')
    this.locations = enabled
  }

  // Set complexity target.
  PresetBuilder.prototype.complexityGoal =
    function goal(complexityMin, complexityMax, goal) {
      assert(
        typeof(complexityMin) === 'number',
        'expected complexityMin to be a number'
      )
      if (Array.isArray(complexityMax)) {
        goal = complexityMax
        complexityMax = undefined
      } else {
        assert(
          typeof(complexityMax) === 'number',
          'expected complexityMax to be a number'
        )
      }
      assert(goal.every(function(lock) {
        return typeof(lock) === 'string'
      }), 'expected goal to be an array of strings')
      assert(Array.isArray(goal), 'expected goal to be an array of strings')
      this.goal = goal.map(function(lock) {
        return new Set(lock)
      })
      this.target = {
        min: complexityMin,
      }
      if (typeof(complexityMax) !== 'undefined') {
        this.target.max = complexityMax
      }
    }

  // Enable guarded relic locations.
  PresetBuilder.prototype.relicLocationsExtension =
    function relicLocationsExtension(extension) {
      assert.oneOf(typeof(extension), ['boolean', 'string'])
      this.extension = extension
    }

  // Create a preset from the current configuration.
  PresetBuilder.prototype.build = function build() {
    const self = this
    let drops = self.drops
    if (typeof(drops) === 'object') {
      drops = {}
      Array.from(self.drops.keys()).forEach(function(enemy) {
        let enemyName
        if (enemy === '*') {
          enemyName = '*'
        } else if (enemy === constants.GLOBAL_DROP) {
          enemyName = enemy
        } else {
          enemyName = enemy.name
          const amb = enemies.filter(function(enemy) {
            return enemy.name === enemyName
          })
          if (amb.length > 1 && enemy !== amb[0]) {
            enemyName += '-' + enemy.level
          }
        }
        drops[enemyName] = self.drops.get(enemy).slice().map(function(item) {
          return item ? item.name : undefined
        })
      })
    }
    let equipment = self.equipment
    if (typeof(equipment) === 'object') {
      equipment = {}
      Object.getOwnPropertyNames(self.equipment).forEach(function(slot) {
        const item = self.equipment[slot]
        if (item) {
          const itemName = item.name
          equipment[slot] = itemName
        } else {
          equipment[slot] = undefined
        }
      })
    }
    let items = self.items
    if (typeof(items) === 'object') {
      items = {}
      Object.getOwnPropertyNames(self.items).forEach(function(zone) {
        items[zone] = {}
        Array.from(self.items[zone].keys()).forEach(function(item) {
          const indexes = self.items[zone].get(item)
          let itemName
          if (item === '*') {
            itemName = '*'
          } else {
            itemName = item.name
          }
          items[zone][itemName] = {}
          Object.getOwnPropertyNames(indexes).forEach(function(index) {
            const replace = self.items[zone].get(item)[index]
            const replaceName = replace.name
            items[zone][itemName][index] = replaceName
          })
        })
      })
    }
    let rewards = self.rewards
    if (typeof(rewards) === 'object') {
      rewards = {}
      Object.getOwnPropertyNames(self.rewards).forEach(function(reward) {
        const item = self.rewards[reward]
        if (item) {
          const itemName = item.name
          rewards[reward] = itemName
        } else {
          rewards[reward] = undefined
        }
      })
    }
    let relicLocations = self.locations
    if (typeof(relics) === 'object') {
      relicLocations = {}
      relics.concat(extension).map(function(location) {
        if (typeof(location.ability) === 'string') {
          return location.ability
        }
        return location.name
      }).forEach(function(location) {
        if (self.locations[location]) {
          const locks = self.locations[location].map(function(lock) {
            return Array.from(lock).join('')
          })
          relicLocations[location] = relicLocations[location] || []
          Array.prototype.push.apply(relicLocations[location], locks)
        }
        if (self.escapes[location]) {
          const locks = self.escapes[location].map(function(lock) {
            return '+' + Array.from(lock).join('')
          })
          relicLocations[location] = relicLocations[location] || []
          Array.prototype.push.apply(relicLocations[location], locks)
        }
      })
      if (self.locations.placed) {
        relicLocations.placed = self.locations.placed
      }
      if (self.goal) {
        let target = self.target.min.toString()
        if ('max' in self.target) {
          target += '-' + self.target.max.toString()
        }
        relicLocations[target] = self.goal.map(function(lock) {
          return Array.from(lock).join('')
        })
      }
      if (self.extension) {
        relicLocations.extension = self.extension
      }
    }
    const music = self.music
    const turkey = self.turkey
    return new Preset(
      self.metadata.id,
      self.metadata.name,
      self.metadata.description,
      self.metadata.author,
      self.metadata.weight || 0,
      drops,
      equipment,
      items,
      rewards,
      relicLocations,
      music,
      turkey,
    )
  }

  function addEventListener(event, listener) {
    if ('addEventListener' in this) {
      this.addEventListener(event, listener)
    } else {
      this.on(event, listener)
    }
  }

  function loadWorker(worker, url) {
    worker.postMessage({
      url: url,
    })
  }

  function randomizeRelics(
    version,
    options,
    seed,
    removed,
    workers,
    nonce,
    url,
    rounds,
  ) {
    if (rounds === undefined) {
      rounds = 1
    }
    const promises = Array(workers.length)
    const running = Array(workers.length).fill(true)
    let done
    for (let i = 0; i < workers.length; i++) {
      const thread = i
      const worker = workers[i]
      loadWorker(worker, url)
      function postMessage(bootstrap) {
        const message = {
          action: constants.WORKER_ACTION.RELICS,
          nonce: nonce++,
          rounds: rounds,
        }
        if (bootstrap) {
          Object.assign(message, {
            bootstrap: true,
            options: options,
            version: version,
            seed: seed,
            removed: removed,
          })
        }
        worker.postMessage(JSON.stringify(message))
      }
      promises[i] = new Promise(function(resolve) {
        addEventListener.call(worker, 'message', function(result) {
          if (self) {
            result = result.data
          }
          result = JSON.parse(result)
          if (result.error && typeof(result.error) !== 'boolean') {
            const error = new Error(result.error.message)
            error.name = result.error.name
            error.stack = result.error.stack
            throw error
          } else if (done || result.done) {
            done = true
            resolve(result)
            running[thread] = false
            worker.postMessage(JSON.stringify({
              action: constants.WORKER_ACTION.RELICS,
              cancel: true,
            }))
          } else {
            postMessage()
          }
        })
        postMessage(true)
      })
    }
    return Promise.all(promises).then(function(results) {
      const result = results.reduce(function(candidate, result, index) {
        if (!candidate || 'error' in candidate) {
          return result
        }
        if ('error' in result || candidate.nonce < result.nonce) {
          return candidate
        }
        return result
      })
      if (result.error) {
        throw result.error
      }
      return result
    })
  }

  function randomizeItems(
    version,
    options,
    seed,
    worker,
    nonce,
    items,
    url,
  ) {
    loadWorker(worker, url)
    return new Promise(function(resolve, reject) {
      addEventListener.call(worker, 'message', function(result) {
        if (self) {
          result = result.data
        }
        if (result.error) {
          reject(result.error)
        } else {
          resolve(result)
        }
      })
      worker.postMessage({
        action: constants.WORKER_ACTION.ITEMS,
        options: options,
        version: version,
        seed: seed,
        nonce: nonce,
        items: items,
        url: url,
      })
    })
  }
  function finalizeData(
    seed,
    preset,
    file,
    data,
    checksum,
    worker,
    url,
  ) {
    loadWorker(worker, url)
    return new Promise(function(resolve, reject) {
      addEventListener.call(worker, 'message', function(result) {
        if (self) {
          result = result.data
        }
        if (result.error) {
          reject(result.error)
        } else {
          resolve(result)
        }
      })
      worker.postMessage({
        action: constants.WORKER_ACTION.FINALIZE,
        seed: seed,
        preset: preset,
        file: file,
        data: data,
        checksum: checksum,
        url: url,
      }, [file])
    })
  }

  function workerCountFromCores(cores) {
    return Math.max(Math.floor(3 * cores / 4), 1)
  }

  function indent(level) {
    return Array(level).fill(' ').join('')
  }

  function minifySolution(min, lock, index) {
    const requirements = Array.from(lock).map(function(node) {
      if (node.locks) {
        const solution = node.locks.reduce(minifySolution, {
          depth: 0,
          weight: 0,
        })
        return {
          item: node.item,
          depth: 1 + solution.depth,
          solution: solution,
        }
      }
      return {
        item: node.item,
        depth: 1,
      }
    })
    const depth = requirements.slice().sort(function(a, b) {
      return a.depth - b.depth
    }).pop().depth
    const weight = requirements.reduce(function(weight, requirement) {
      return weight + requirement.depth
    }, 0)
    const avg = weight / requirements.length
    const solution = {
      depth: depth,
      weight: weight,
      avg: avg,
      requirements: requirements,
    }
    if (min.depth === 0
        || solution.depth < min.depth
        || (solution.depth === min.depth
            && solution.weight < min.weight)
        || (solution.depth === min.depth
            && solution.weight === min.weight
            && solution.avg < min.avg)) {
      return solution
    }
    return min
  }

  function simplifySolution(node) {
    if (node.solution) {
      return {
        item: node.item,
        solution: node.solution.requirements.map(simplifySolution)
      }
    }
    return {
      item: node.item,
    }
  }

  function collectAbilities(node, map) {
    if (map.has(node.item)) {
      return map.get(node.item)
    }
    const abilities = new Set([node.item])
    if (node.solution) {
      node.solution.requirements.forEach(function(node) {
        abilities.add(node.item)
        Array.from(collectAbilities(node, map)).forEach(function(ability) {
          abilities.add(ability)
        })
      })
    }
    map.set(node.item, abilities)
    return abilities
  }

  function pruneSubsets(node, map) {
    map = map || new Map()
    if (node.solution) {
      const nodes = node.solution.requirements
      nodes.sort(function(a, b) {
        return b.depth - a.depth
      })
      const abilities = new Set()
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]
        pruneSubsets(node, map)
        Array.from(collectAbilities(node, map)).forEach(function(ability) {
          abilities.add(ability)
        })
        for (let j = i + 1; j < nodes.length; j++) {
          const curr = nodes[j]
          const requirements = Array.from(collectAbilities(curr, map))
          if (requirements.every(function(ability) {
            return abilities.has(ability)
          })) {
            nodes.splice(j--, 1)
          }
        }
      }
    }
  }

  function collapseSolution(node) {
    const items = []
    let curr = node
    while (curr.solution && curr.solution.length === 1) {
      items.push(curr.item)
      curr = curr.solution[0]
    }
    items.push(curr.item)
    if (curr.solution) {
      return {
        items: items,
        solution: curr.solution.map(collapseSolution)
      }
    }
    return {
      items: items,
    }
  }

  function renderNode(indentLevel, sub, node) {
    const lines = []
    const names = node.items.map(function(ability) {
      return relicFromAbility(ability).name
    })
    lines.push(
      indent(indentLevel)
        + (sub ? '^ ' : '')
        + names.join(' < ')
    )
    if (node.solution) {
      if (sub) {
        indentLevel += 2
      }
      indentLevel += names.slice(0, -1).concat(['']).join('   ').length
      const nodes = node.solution.map(renderNode.bind(null, indentLevel, true))
      Array.prototype.push.apply(lines, nodes.reduce(function(lines, node) {
        Array.prototype.push.apply(lines, node)
        return lines
      }, []))
    }
    return lines
  }

  function renderSolutions(solutions, indentLevel) {
    const minified = solutions.reduce(minifySolution, {
      depth: 0,
      weight: 0,
    })
    minified.requirements.forEach(function(node) {
      pruneSubsets(node)
    })
    const simplified = minified.requirements.map(simplifySolution)
    const collapsed = simplified.map(collapseSolution)
    const render = renderNode.bind(null, 0, false)
    return collapsed.map(render).reduce(function(lines, node) {
      Array.prototype.push.apply(lines, node)
      return lines
    }, [])
  }

  const exports = {
    assert: assert,
    shopTileFilter: shopTileFilter,
    dropTileFilter: dropTileFilter,
    rewardTileFilter: rewardTileFilter,
    candleTileFilter: candleTileFilter,
    tankTileFilter: tankTileFilter,
    mapTileFilter: mapTileFilter,
    nonProgressionFilter: nonProgressionFilter,
    tilesFilter: tilesFilter,
    itemTileFilter: itemTileFilter,
    tileIdOffsetFilter: tileIdOffsetFilter,
    itemFromName: itemFromName,
    itemFromTileId: itemFromTileId,
    tileValue: tileValue,
    tileData: tileData,
    entityData: entityData,
    romOffset: romOffset,
    bufToHex: bufToHex,
    numToHex: numToHex,
    checked: checked,
    optionsFromString: optionsFromString,
    optionsToString: optionsToString,
    optionsFromUrl: optionsFromUrl,
    optionsToUrl: optionsToUrl,
    setSeedText: setSeedText,
    saltSeed: saltSeed,
    restoreFile: restoreFile,
    formatObject: formatObject,
    formatInfo: formatInfo,
    newInfo: newInfo,
    mergeInfo: mergeInfo,
    sanitizeResult: sanitizeResult,
    shuffled: shuffled,
    isItem: isItem,
    isRelic: isRelic,
    isCandle: isCandle,
    isContainer: isContainer,
    containedItem: containedItem,
    relicFromName: relicFromName,
    relicFromAbility: relicFromAbility,
    enemyFromIdString: enemyFromIdString,
    Preset: Preset,
    PresetBuilder: PresetBuilder,
    randomizeRelics: randomizeRelics,
    randomizeItems: randomizeItems,
    finalizeData: finalizeData,
    renderSolutions: renderSolutions,
    workerCountFromCores: workerCountFromCores,
  }
  if (self) {
    self.sotnRando = Object.assign(self.sotnRando || {}, {
      util: exports,
    })
  } else {
    module.exports = exports
  }
})(typeof(self) !== 'undefined' ? self : null)
