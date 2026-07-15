#!/bin/zsh
set -e
colima status >/dev/null 2>&1 || colima start --cpu 4 --memory 8
cd /Users/stewartos/Downloads/Gymstant/demo-software/education
docker-compose -f docker/docker-compose.yml up -d
for _ in {1..60}; do
  curl -fsS http://education.localhost:8000 >/dev/null 2>&1 && break
  sleep 2
done
docker cp education/demo_seed.py education-frappe-1:/home/frappe/frappe-bench/apps/education/education/demo_seed.py
docker exec education-frappe-1 bash -lc 'cd /home/frappe/frappe-bench && bench --site education.localhost execute '\''frappe.get_attr("education.demo_seed.seed")()'\''' >/dev/null
docker exec education-frappe-1 bash -lc 'cd /home/frappe/frappe-bench && bench --site education.localhost execute '\''frappe.get_attr("education.demo_seed.reset_makeup")()'\''' >/dev/null
open http://education.localhost:8000
open /Users/stewartos/Downloads/Gymstant/release/mac-arm64/Gymstant.app
