# Bảo mật

- Báo lỗ hổng: liên hệ riêng chủ repository, không mở issue công khai.
- Mật khẩu: scrypt (N=2^17, r=8, p=1). Token phiên: 256 bit ngẫu nhiên, chỉ lưu SHA-256.
- MFA TOTP (RFC 6238); secret mã hóa AES-256-GCM bằng `MFA_ENCRYPTION_KEY`.
- Cách ly tenant bằng PostgreSQL Row-Level Security (FORCE), API chạy bằng role không phải owner.
- Audit log chỉ INSERT (trigger chặn UPDATE/DELETE) và có chuỗi hash SHA-256 theo tenant.
- CI quét secret bằng gitleaks và chặn phụ thuộc có lỗ hổng mức high trở lên.
