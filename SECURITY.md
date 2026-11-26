# Bảo mật

- Báo lỗ hổng: liên hệ riêng chủ repository, không mở issue công khai.
- Mật khẩu: scrypt (N=2^17, r=8, p=1). Token phiên: 256 bit ngẫu nhiên, chỉ lưu SHA-256.
- MFA TOTP (RFC 6238); secret mã hóa AES-256-GCM bằng `MFA_ENCRYPTION_KEY`.
- Cách ly tenant bằng PostgreSQL Row-Level Security (FORCE), API chạy bằng role không phải owner.
- Audit log chỉ INSERT (trigger chặn UPDATE/DELETE) và có chuỗi hash SHA-256 theo tenant.
- Phiên trình duyệt: cookie `maris_session` httpOnly, SameSite=Lax, Secure khi production; ghi bằng cookie phải có header `X-MARIS-CSRF`.
- Secret Vault: AES-256-GCM bằng `VAULT_MASTER_KEY`, gắn tenant và id làm AAD; giá trị chỉ ghi, không bao giờ trả qua API, không vào audit hay sự kiện.
- Rate limit trên Redis: 600 yêu cầu/phút/IP; đăng nhập 20 lần/15 phút theo IP và theo email; chấp nhận lời mời 20 lần/15 phút/IP.
- Lời mời: token 256 bit, chỉ lưu SHA-256, hết hạn sau 7 ngày, dùng một lần; không gán được Owner, không cấp quyền mình không có.
- CI quét secret bằng gitleaks và chặn phụ thuộc có lỗ hổng mức high trở lên.
