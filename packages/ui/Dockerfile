FROM node:24-alpine AS build
WORKDIR /repo
COPY . .
RUN npm ci --workspace @ultimatelemon-eu/ui
RUN npm run build-storybook --workspace @ultimatelemon-eu/ui -- --quiet -o /storybook

FROM nginx:1.29-alpine
COPY --from=build /storybook /usr/share/nginx/html
