FROM alpine:3.20

RUN apk add --no-cache openssh \
  && adduser -D -h /home/jemacs jemacs \
  && echo 'jemacs:tramp-test' | chpasswd \
  && ssh-keygen -A \
  && mkdir -p /home/jemacs/workspace/subdir \
  && printf 'hello from virtual ssh\n' > /home/jemacs/workspace/hello.txt \
  && printf 'hidden\n' > /home/jemacs/workspace/.hidden \
  && chown -R jemacs:jemacs /home/jemacs \
  && printf '\nPasswordAuthentication yes\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowUsers jemacs\n' >> /etc/ssh/sshd_config

EXPOSE 22

CMD ["/usr/sbin/sshd", "-D", "-e"]
