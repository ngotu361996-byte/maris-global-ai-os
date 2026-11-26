import { migrate } from './migrate';

const url = process.env.DATABASE_ADMIN_URL;
if (!url) {
  console.error('DATABASE_ADMIN_URL is required');
  process.exit(1);
}
migrate(url)
  .then((applied) => {
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
