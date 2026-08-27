//! Windows command-line argument quoting.
//!
//! Kept as plain, platform-independent Rust (no `windows` crate types) even
//! though it is only used from the Windows-only restricted-token spawn path,
//! specifically so it can be unit-tested on any machine — the rest of that
//! path cannot be exercised at all without a Windows box, so this is the one
//! piece of it that gets to be verified before it ships.
//!
//! Implements the algorithm `CommandLineToArgvW` expects (also what
//! `std::process::Command` does internally on Windows, and documented by
//! Microsoft): wrap in quotes if the argument is empty or contains a space,
//! tab, or quote; double any run of backslashes that is immediately followed
//! by a quote (plus one more backslash to escape that quote), or that sits at
//! the very end of the argument (because it will be followed by the closing
//! quote we add); backslashes not followed by a quote pass through unchanged.

pub fn quote_arg(arg: &str, out: &mut String) {
    let needs_quotes = arg.is_empty() || arg.chars().any(|c| c == ' ' || c == '\t' || c == '"');
    if !needs_quotes {
        out.push_str(arg);
        return;
    }

    out.push('"');
    let chars: Vec<char> = arg.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let mut backslashes = 0;
        while i < chars.len() && chars[i] == '\\' {
            backslashes += 1;
            i += 1;
        }

        if i == chars.len() {
            out.extend(std::iter::repeat('\\').take(backslashes * 2));
        } else if chars[i] == '"' {
            out.extend(std::iter::repeat('\\').take(backslashes * 2 + 1));
            out.push('"');
            i += 1;
        } else {
            out.extend(std::iter::repeat('\\').take(backslashes));
            out.push(chars[i]);
            i += 1;
        }
    }
    out.push('"');
}

pub fn build_command_line(exe: &str, args: &[String]) -> String {
    let mut line = String::new();
    quote_arg(exe, &mut line);
    for a in args {
        line.push(' ');
        quote_arg(a, &mut line);
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(s: &str) -> String {
        let mut out = String::new();
        quote_arg(s, &mut out);
        out
    }

    #[test]
    fn plain_argument_is_unquoted() {
        assert_eq!(q("hello"), "hello");
    }

    #[test]
    fn argument_with_space_is_quoted() {
        assert_eq!(q("C:\\Program Files\\pg"), "\"C:\\Program Files\\pg\"");
    }

    #[test]
    fn empty_argument_becomes_empty_quotes() {
        assert_eq!(q(""), "\"\"");
    }

    #[test]
    fn embedded_quote_is_escaped() {
        assert_eq!(q("say \"hi\""), "\"say \\\"hi\\\"\"");
    }

    #[test]
    fn trailing_backslash_before_closing_quote_is_doubled() {
        // A single trailing backslash must become two, so the parser sees an
        // escaped backslash followed by the real closing quote, not an
        // escaped quote.
        assert_eq!(q("C:\\a path\\"), "\"C:\\a path\\\\\"");
    }

    #[test]
    fn backslashes_not_before_a_quote_pass_through() {
        assert_eq!(q("a\\\\b c"), "\"a\\\\b c\"");
    }

    #[test]
    fn full_command_line_joins_with_spaces() {
        let line = build_command_line(
            "C:\\pg\\bin\\postgres.exe",
            &["-D".into(), "C:\\Program Files\\GreenPlusPOS\\pgdata".into(), "-p".into(), "5432".into()],
        );
        assert_eq!(
            line,
            "C:\\pg\\bin\\postgres.exe -D \"C:\\Program Files\\GreenPlusPOS\\pgdata\" -p 5432"
        );
    }
}
