//! The game's variable-length integers: seven bits per byte, low bits first,
//! the high bit set on every byte but the last.

/// VarInt decode result.
#[derive(Debug, Clone, Copy)]
pub struct VarIntResult {
    pub value: i32,
    pub length: i32,
}

impl VarIntResult {
    pub fn invalid() -> Self {
        Self { value: -1, length: -1 }
    }
}

/// The varint at `offset`, as A2Tools' stream processor reads it (a value that
/// would not fit an i32 is invalid).
pub fn read_varint(bytes: &[u8], offset: usize) -> VarIntResult {
    let mut value: i32 = 0;
    let mut shift = 0;
    let mut count = 0;

    loop {
        if offset + count >= bytes.len() {
            return VarIntResult::invalid();
        }

        let byte_val = bytes[offset + count] as u32;
        count += 1;

        value |= ((byte_val & 0x7F) as i32) << shift;

        if byte_val & 0x80 == 0 {
            return VarIntResult { value, length: count as i32 };
        }

        shift += 7;
        if shift >= 32 {
            return VarIntResult::invalid();
        }
    }
}

/// A varint as an unsigned value, advancing `pos` past it.
pub fn take_varint(bytes: &[u8], pos: &mut usize) -> Option<u64> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = *bytes.get(*pos)?;
        *pos += 1;
        value |= u64::from(byte & 0x7F) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_and_two_byte_values() {
        let r = read_varint(&[0x05], 0);
        assert_eq!((r.value, r.length), (5, 1));
        let r = read_varint(&[0x87, 0x01], 0);
        assert_eq!((r.value, r.length), (135, 2));
        let mut pos = 0;
        assert_eq!(take_varint(&[0x87, 0x01, 0x02], &mut pos), Some(135));
        assert_eq!(pos, 2);
    }

    #[test]
    fn a_cut_varint_is_invalid() {
        assert_eq!(read_varint(&[0x87], 0).length, -1);
        assert_eq!(take_varint(&[0x87], &mut 0), None);
    }
}
